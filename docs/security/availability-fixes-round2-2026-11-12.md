# Availability fixes, round 2 (2026-11-12)

Branch `availability-fixes`, on top of round 1 (`3aae0c0`) with the independent re-review
(`rereview-availability-2026-11-12`, `7c9de0f`) merged in. This answers
`docs/security/rereview-availability-2026-11-12.md`. The round-1 write-up
(`docs/security/availability-fixes-2026-11-11.md`) is corrected in place where it stated a best
case as the result (RR-15).

Nothing here changes a price, a pricing rule, a gate threshold or a DFM threshold, and the
geometry result of every file in the vetting library is the same: the 300-quote vetting run is
identical to the run made before any round-2 change (section 8). Two kinds of file that used to
be priced are now sent to a person instead (RR-09): a mesh with one closed shape inside another,
and a printed part too thin or too small to print.

Contents: 1 what was wrong with round 1 and the state of each finding, 2 finding by finding,
3 new settings, 4 who can hold how much of what, 5 new refusals and their wording, 6 judgment
calls, 7 merge notes, 8 every run, 9 still open.

## 1. What was wrong with round 1, and where each finding stands

Round 1 limited *how many*: drafts per hour, pricing requests in flight, requests per hour for the
site, emails per hour for the site. The re-review showed that a count is not a cost (one draft can
be 4 kB or 295 kB; one quote can price in 3 ms or 1.5 s) and that a shared cap with nothing
reserved is itself the outage (the first 30 senders close the form to everyone else). Round 1 was
also measured on the best case: identical lines, one part repeated, no account.

Round 2 follows four rules, and every test and run in it uses the re-review's worst case (lines
that all differ, different dense parts, a confirmed account, several addresses, re-pricing as well
as creating):

- **A.** Quotas per sender are in bytes or in seconds of work, checked on create and on
  re-price. No single sender, and no ten of them, can bring a shared ceiling to the point where
  somebody else is refused (section 4 gives the arithmetic for each ceiling).
- **B.** Under pressure, removal goes to the heaviest holder first; never a lighter holder's row
  while a heavier one still has removable rows; never a signed-in customer's upload in its first
  hour.
- **C.** A site-wide cap does not drop a first-time legitimate action: each address's first two
  are outside it, and an email over the line is held and sent, not dropped.
- **D.** An account is not a trust boundary: every reserve for accounts has its own per-account
  quota.

| Finding | Severity (re-review) | State | Measured on the re-review's own script |
|---|---|---|---|
| RR-13 pricing different dense parts from eight addresses | High | **Fixed** | Eight addresses: health median 2 ms quiet, 8 ms loaded (was 3,065 ms); a visitor's one-line re-price median 31 ms quiet, 34 ms loaded (was 2,995 ms) |
| RR-05 reorder prices with no gate | High | **Gate and runner exported; route not edited (integration)** | With the three-line change of section 7 applied for the run: a reorder 51 to 62 ms (was 3.0 to 3.8 s on this machine, 10.8 to 15.3 s in the re-review); the fourth of four at once is told to wait (429) |
| RR-01 one account fills the database | High | **Fixed** | One address and one account: 0.6 MB of an 8 MB or 16 MB ceiling, everyone else served (was 100 %, everyone refused, nothing cleared it) |
| RR-02 no account: cheap pause, unchecked re-price, wrong rows removed | High, check off | **Fixed for growth by re-pricing and for who is removed. Reduced, not removed, for a flood from many addresses** | Growth by re-pricing: 8 % of the ceiling (was 107 %). Addresses to pause visitors without an account: 57 in an hour at the default (was 25 at 64 MB), 29 at 8 MB (was 4); the pause ends when the flood's rows are two minutes old. The clean-up removed 190 of the flood's drafts and none of the visitor's or the customer's (it removed theirs before) |
| RR-08 the file ceiling pinned by requests and saved quotes | High | **Fixed** | Six addresses fill and pin the folders to 97 % as before (the script fixes the sizes); after the pass: 71 %, a visitor and a confirmed customer both upload again, nobody deleted anything (before: nothing removed, both refused until the owner deleted the requests by hand) |
| RR-03 30 requests close the form | High, check off | **Fixed** | After 38 accepted requests from 4 addresses, a visitor's request: 201 (was 429). Production refuses to start without the Turnstile keys unless waived |
| RR-04 the mail cap used up by one address | High | **Fixed** | After 60 accounts from six addresses, a new customer's confirmation email is sent (it was dropped). One address: 15 emails in five minutes (was 60) |
| RR-11 the clean-up pass freezes the server; saves grow with the database | Medium | **Pass fixed. Save contained by a 16 MB default, not changed** | A pass above 80 % that removes rows: the thread held 31 to 110 ms in one run and 27 to 81 ms in the next, after the compaction was split in two (was 2.2 to 2.4 s, removing nothing). A save at the default ceiling: 10 ms quiet (29 ms on the re-review's loaded machine) |
| RR-07 two customers, one refused for memory | Medium | **Fixed for refusals; memory the process keeps is open** | Two customers at once: 6 of 6 served quiet (twice), 20 of 20 in ten rounds, 6 of 6 under load (was 1 of 2 refused in 2 of 4 runs). A customer beside a memory-hungry file: served 3 of 3 and never the one stopped |
| RR-09 finite but wrong measurements | Medium | **Fixed** | Every hostile row of the script is refused at upload; the honest cube and frame price to the cent as before |
| RR-06 a refused upload's connection | Low | **Fixed** | Thrown-away bytes are charged (the next upload is `daily-upload-limit`); the second request on the connection is not run |
| RR-12 the start-up key check went quiet | Low | **Fixed** | After 30 new uploads under the new key and a restart, the start-up error is printed (`afterNewUploadsUnderTheNewKey.startupErrorPrinted: true`) while the old parts are still locked. The message now counts all files ("8 of the 10 encrypted files on the volume") |
| RR-15 accuracy of the round-1 write-up | Info | **Corrected in place** | n/a |
| RR-10, RR-14 | High, Low | Not in this work (integration) | `geometry-price.js units` and `memo-check.js` read as in the re-review |

The code this describes is commit `2f82141` of `availability-fixes` (this write-up is the commit after it). Nothing was pushed by me.

## 2. Finding by finding

"Before" is the re-review's own measurement on the round-1 code (its report, load average 3 to 9
on 2 cores). "After" is the same script, unchanged unless the row says "adapted", on this branch.
Section 8 has every run with its load average. The machine was quiet for the main runs (load 0.3
to 1.5); the load-sensitive ones were run a second time with four busy loops on the two cores
(load 4 to 6), and both are given.

### RR-13 and RR-05. Pricing different dense parts from several addresses (High)

**Root cause.** Round 1 made one request cheap (a part repeated on every line is priced once) and
limited the *number* of pricing requests in flight for the site (8). Neither is a limit on pricing
*time*. With 25 different dense parts the memo saves nothing, each address may run one request,
eight addresses run eight, and the eight slots themselves were a door that eight addresses could
hold shut. The reorder route had no gate at all.

**Fix.** `server/services/pricingMemo.js` is now the one runner for the site, and every pricing
request goes through it:
- One piece of pricing work at a time, the event loop turning between pieces
  (`QUOTE_PRICE_SLICE_MS`, 20 ms), so health checks and everything else are answered between them.
- Two lanes. A quote is *light* when the stored detail of its distinct parts is under 256 kB
  (`QUOTE_PRICE_LIGHT_KB`); the usual quote is. Light quotes never wait behind heavy ones. A light
  quote that has used 150 ms (`QUOTE_PRICE_LIGHT_MS`) is moved to the heavy lane.
- The heavy lane, all senders together, may run at full speed for one second after a quiet spell
  and then gets a third of the time (`QUOTE_PRICE_HEAVY_BURST_MS`, `QUOTE_PRICE_HEAVY_DUTY_PERCENT`).
  This is site-wide on purpose: a per-sender share is no limit at all against fresh addresses.
- Within a lane, the sender that has used the least pricing time this hour goes first.
- Every piece of work is charged, in milliseconds, to the address and to the account. Past 120 s
  in an hour (`QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR`, `QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR`) the
  sender is told when to come back and offered the firm quote (`pricing-budget`).
- The site-wide count of requests in flight is gone. A full line (200 waiting, or 15 s in line)
  answers `pricing-busy` with `Retry-After`.
- `pricingGate.admit()`, `pricingGate.job()`, `pricingGate.context()` and `pricingMemo.run()` are
  exported for the reorder route (section 7).

Prices are bit-identical: the same functions produce the same numbers, only in a different order
of turns (vetting, section 8).

**Worst case, before and after** (`pricing-eight.js`: 25 different 3,000-hole drawings per quote,
no account, each address re-pricing as fast as it is allowed; a ninth visitor re-prices a one-line
quote every two seconds):

| Attacking addresses | Before (re-review, load 6.3 to 7.1): health median / worst; visitor median | After, quiet, run 2 (load 0.6 to 1.2): health median / worst; visitor median / worst | After, loaded with four busy loops (load 4.6 to 4.7): health median / worst; visitor median / worst |
|---|---|---|---|
| none | 5 ms / 79 ms; n/a | 2 ms / 6 ms; n/a | 6 ms / 13 ms; n/a |
| 1 | 93 ms / 1,255 ms; 166 ms | 2 ms / 100 ms; 14 ms / 56 ms | 9 ms / 116 ms; 92 ms / 185 ms |
| 2 | 494 ms / 1,152 ms; 527 ms | 2 ms / 89 ms; 11 ms / 92 ms | 8 ms / 113 ms; 49 ms / 160 ms |
| 4 | 1,106 ms / 3,162 ms; 1,340 ms | 2 ms / 83 ms; 30 ms / 159 ms | 9 ms / 129 ms; 36 ms / 232 ms |
| 8 | 3,065 ms / 6,133 ms; 2,995 ms | 2 ms / 112 ms; 31 ms / 78 ms | 8 ms / 92 ms; 34 ms / 191 ms |

One such quote alone: 1.3 to 1.5 s before (loaded); 0.45 s now on the quiet machine and 1.29 s under
the busy loops. In every phase of every run the visitor got a price on every try (13 of 13, or 12
of 12). The attackers between them priced 31 to 41 quotes per 25 s phase when quiet and 14 to 20
loaded, which is the third of the thread they share; with eight addresses under load, 5 of their
requests were answered `pricing-busy`.

Acceptance target (health median under 250 ms, visitor's one-line re-price median under 1 s, with
eight attacking addresses): met in every run, quiet and loaded.

**Run 1 is not in the table, and this is why.** The first quiet run, started two minutes after the
container had been restarted, had one stall of 19.9 s in its first phase (one attacking address):
the health check and the visitor's request both waited 19.5 to 19.9 s once, and one attacker quote
was answered `quote-too-slow`. Its other three phases were as run 2 (health median 2 ms, worst 67
to 159 ms). I could not reproduce it: run 2 and the loaded run, on the same code, have no sample
over 232 ms. What I can show is that the machine's disk stood still around then: the kernel's
pressure counter (`/proc/pressure/io`, "full") read 79 s of complete IO stall in the 13 minutes
since boot when I looked two minutes later, and climbed to 334 s over the next two hours while my
own runs wrote large database files. Over those two hours a separate idle process watching a
100 ms timer never once saw the machine itself stand still for 400 ms, so the stalls here are the
disk, not the processor. The server writes its database synchronously, so while the disk does not
answer, nothing does. I am reporting it as seen once, cause not proven, and not as fixed
(section 9).

`stall-probe.js storm` (one account, eight workers re-pricing a 100-line quote of one 4,900-hole
part): quiet, 76 priced and 880 told to retry in 30 s, health median 1 ms, worst 138 ms, 3 of 1,018
samples over 100 ms; under the busy loops, 59 priced, health median 2 ms, worst 319 ms, 34 of 852
over 100 ms. The longest single hold of the thread the probe saw was 53 ms quiet and 118 ms loaded:
one line of that part, which cannot be cut into pieces.

**Reorder (RR-05).** `reorder-block.js` on this branch as it stands: unchanged from the re-review
(here, quiet: a reorder 3.0 to 3.8 s, health median 2.4 s and worst 3.7 s during three in a row, 10 s with four at once; in the re-review, loaded: 10.8 to 15.3 s a reorder), because the route is not mine to edit. With the change of section 7 applied
in the working tree for the run and reverted afterwards: a reorder 51 to 62 ms; health worst 12 ms during three in a row; four at once: three answered 201, the fourth 429 (wait your turn), 152 ms in all, health worst 40 ms. With only the gate and the runner, without the `getRow` line of section 7, a reorder was still 0.7 to 0.9 s with health median 426 ms: the route reads each part's whole measurement file once per line before any pricing starts.

### RR-01 and RR-02. Draft quotes fill the database (High)

**Root cause.** Round 1 counted *drafts per hour* and assumed a draft is small. A draft of 100
lines that all differ was 78 kB (identical lines had hidden that), re-pricing was never counted or
checked so a row could be made small and grown later, an account's drafts were never removed, and
the clean-up chose by idle age, which the flood controls and a real visitor does not.

**Fix.**
- **Allowance in bytes per sender, checked on create and on re-price**
  (`server/security/quoteGuards.js`, called from `saveQuote` in `server/routes/api.js`): 512 kB of
  stored drafts per address and per account. A re-price that grows a row is checked against the
  same allowance and, above the database's own lines, against the ceiling. An address that is over
  makes room from its own idle no-account drafts first (untouched 10 minutes); only if it has none
  is it refused (`drafts-full`).
- **Re-pricing one quote is limited to 300 an hour** (`reprice-limit`): a person changing a quote
  does not get near it, a loop does.
- **Stored lines are compressed** (`server/models/quotesStore.js`): 100 different lines are
  282 kB as JSON and 14 kB as stored. This does not replace the allowance (it is what the
  allowance is counted in); it means 512 kB is a great many real quotes.
- **Who gives way under pressure: the heaviest holder first** (`server/services/storagePressure.js`,
  `rowRetention.js`). A pass lowers the heaviest holder to the next one's level, and so on, until
  enough is freed. An account's drafts that no order or request came from can go, down to its
  newest 64 kB. Nobody's row younger than two minutes goes, and never a lighter holder's row while
  a heavier holder still has rows above the level.
- **The admin's "Clear old drafts" button** runs the same pass, forced, when the database is over
  its line, so it always does what can be done, and says how many it took "from whoever held the
  most".
- **A refused new quote now sets off the clean-up** as a refused upload did (RR-15 point 2).
- **"Inputs plus price" instead of the full cost build-up: not done, not contained.** The stored
  line's build-up (`meta`, `quantityBreaks`) is copied into the order item at checkout
  (`server/routes/orders.js`), and read by the documents, the gate, the request form and the
  quote page. Dropping it touches the order, the traveler and the customer's documents in four
  lanes. Compression gets most of the saving with none of that.

**Worst case, before and after:**

| Run | Before (re-review, load 4 to 6.5) | After (quiet, load 0.3 to 2.3) |
|---|---|---|
| `size`: what one draft adds to the database file | 25 different lines, no account: 77,824 bytes. 100 different lines, signed in: 294,912 | 12,288 and 16,384 bytes (whole pages of the file; 8.3 to 8.4 kB and 21.7 kB a draft averaged over a run) |
| `account`, 8 MB ceiling: one address, one confirmed account, 100 different lines a quote | 28 drafts in 5 s, then `storage-full` for everyone; nothing clears it; the same after a restart | 30 drafts (0.6 MB, 8 % of the ceiling), then the hourly limit. Afterwards, after the pass and after a restart: confirmed customer's upload and new quote 200, visitor's upload 200 |
| `account` at the default 16 MB | n/a | the same: 0.6 MB, everyone served |
| `grow`, 8 MB: 30 one-line drafts each re-priced to 100 lines | all 30 re-prices accepted; database 8.59 MB, **107 % of the ceiling**; a confirmed customer's upload 503 | all 30 accepted; database 0.62 MB, **8 %** (4 % at 16 MB); everyone served. A sender's rows stop growing at its 512 kB (unit test below) |
| `anon`, 8 MB, no account, 25 different lines a quote | **4 addresses**, 92 drafts: visitors without an account paused | **29 addresses**, 845 drafts, then the same pause; confirmed customers served |
| `anon` at the default ceiling | 25 addresses in an hour at 64 MB (7 over a day) | **57 addresses** in an hour at 16 MB (1,709 drafts, 13.6 MB) |
| `anon` with the robot check on (stand-in) | the same as off | the same as off (29 addresses at 8 MB) |
| `eviction-collateral`, 4 MB ceiling, 6.5 minutes | the flood (2 addresses, re-priced to stay fresh) kept all of its first ten drafts; a real visitor's quote **404**, their part gone; a confirmed customer's uploaded part gone | the flood needed 19 addresses; the pass removed **190 of the flood's drafts** ("from whoever held the most first", 3.4 to 2.3 MB, longest piece 17 ms); 1 of its first ten is left; the visitor's quote **200** and re-prices; the customer's uploaded part **200**, their saved quote 200 |

`anon` stops at the moment the pause begins and does not wait. What follows, from the unit tests
and `eviction-collateral`: the flood's rows are spared for two minutes from creation; then the pass
takes every holder down to its newest 64 kB, heaviest first, and the pause ends. Each address may
start 30 drafts an hour (about 250 kB of these), so to *hold* the default database at 85 % a
flood needs about 54 fresh addresses every two minutes, or about 210 addresses that each keep
their last 64 kB. Ten addresses at their full allowance hold 5 MB, under half of the clean-up line, and cannot hold more.

Permanent tests (`server/services/senderQuotas.test.js`, 9 tests): one address and one confirmed
account saving 100-line quotes that all differ are stopped at the account's allowance while
another address and another customer are not refused; one-line drafts grown by re-pricing stop at
the address's allowance; a quote re-priced 300 times in an hour gets `reprice-limit`; with the
database over its line the admin's button removes the heaviest account's drafts and leaves a
lighter customer's saved quote alone; a pass that comes while the flood's rows are too new looks
again when they are two minutes old, not five minutes later.

### RR-08. The file ceiling pinned by requests and saved quotes (High)

**Root cause.** A file on an open request, on a signed-in customer's saved quote or on an unpaid
order was never evicted, and nothing limited how much of that one sender could hold. One request
per address was enough to pin 400 MB each.

**Fix.**
- Stored bytes are capped per account as well as per address, at 150 MB (was 400 per address,
  nothing per account): `server/security/uploadGuards.js`.
- What a holder can keep safe through *unpaid or unanswered* things is capped at 50 MB
  (`UPLOAD_PROTECTED_MB_PER_HOLDER`). Beyond it, when the folders are past 80 %, the heaviest
  holder's oldest such files are cleared: files on a request nobody at the shop has taken up, on a
  saved quote (the quote goes with its file), on an order unpaid after 48 hours. An unanswered
  request's own attachment counts too.
- Cancelled and expired orders protect nothing (the states the order-lifecycle branch writes).
- Never cleared: a file on a paid order or one being worked on, or on a request the shop has
  taken up.

**Worst case, before and after** (`storage-pin.js`, scaled 1:10 by the script):

| | Before (re-review, load 6.1 to 6.7) | After (quiet, load 0.4) |
|---|---|---|
| `pin`: five addresses fill their stored allowance and pin it with one request each; a sixth, with a confirmed account, takes the rest | visitors paused at 84 %, everyone refused at 97 % | the same fill (the script fixes the ceiling at 200 MB and the allowance at 40 MB): paused at 82 %, everyone refused at 97 % |
| Right after | visitor `uploads-paused`; a confirmed customer `storage-full` | the same |
| After the pressure pass | **nothing removed; both still refused** until the owner deleted the six requests by hand | **13 uploads removed, "from whoever held the most first", 194.9 to 126.4 MB (71 %); the visitor and the confirmed customer both accepted.** Nobody deleted anything |
| `control` (the same uploads, no requests) | 24 removed, back to 71 %, both accepted | 13 removed, back to 71 %, both accepted |

At the defaults the fill itself is also further away than in the script: 150 MB per sender
instead of 400 puts the clean-up line at eleven senders, not five (section 4).

Permanent tests (`server/services/senderQuotas.test.js`): stored bytes are capped per account as
well as per address; files pinned by unanswered requests, saved quotes and unpaid orders are
cleared from the heaviest holder beyond its protected share, while files on a paid order or a
request the shop has taken up, and everything of a lighter holder, are untouched.

### RR-03. The site-wide cap on requests closes the form to everyone (High with the robot check off)

**Root cause.** A shared cap with nothing reserved: the first 30 requests of the hour from
unverified senders used it up, whoever sent them.

**Fix.** Each address's first two requests an hour are outside the cap
(`server/security/botGuard.js`, `rfqGate.js`): they always pass and do not count toward the 30.
The cap now only limits what an address sends beyond its first two. And in production the server
refuses to start without the Turnstile keys, with one plain line saying which settings are missing,
unless `ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1` is set (`server/security/botCheckStartup.js`, following
the `STRIPE_WEBHOOK_SECRET` precedent). Tests and local development are unaffected (not
production; the test harness sets the waiver for the production-mode servers it starts).

**Before and after** (`site-caps.js rfq`):

| | Before (re-review) | After (quiet, load 1.3) |
|---|---|---|
| Robot check off: attacker | 32 requests from 3 addresses, 29 accepted, then `requests-paused` | 42 requests from 4 addresses, 38 accepted (each address's first 2, then the 30), then `requests-paused` for those four |
| A real visitor without an account, afterwards | 429 `requests-paused`, Retry-After 1,800 | **201** |
| A signed-in account with an unconfirmed email, afterwards | 429 | 201 |
| A signed-in confirmed customer | 201 | 201 |
| Robot check on (stand-in) | attackers refused 403 and not counted; visitor and customer 201 | the same |

What the attacker still gets: its own 38 requests in the shop's inbox in that hour (10 per address,
the per-address limit that was already there), and the notice cap of 40 an hour to the shop's inbox
is unchanged.

### RR-04. The site-wide cap on confirmation email (High)

**Root cause.** The same shape: 60 an hour for the site, first come first served, and "send it
again" limited per account only, so one address with ten accounts used the hour up in four
minutes. Over the cap the email was dropped, the customer was told `sent: false`, and the attempt
was still counted against them.

**Fix** (`server/services/mailCaps.js`, `mailer.js`, `server/routes/auth.js`):
- Each address's first two emails an hour to unconfirmed recipients are outside the 60.
- "Send it again" is limited per address (5 an hour) as well as per account.
- Over a line, the email is **held and sent when the hour turns**, each address's first before
  anyone's second, and the customer reads "Yours is in line and will arrive within the hour; you
  don't need to ask again." One of the day's five tries is used by every request as before, except
  one the site's own cap turned away with nothing left in line (an address that already has three
  waiting).
- A hard line at 300 an hour protects the sending domain; past it even first emails are held.
- The pages show the message (`VerifyEmailNotice.jsx`, `VerifyEmailPage.jsx`).

**Before and after** (`site-caps.js mail`, `mail-one`):

| | Before (re-review) | After (quiet, load 0.0 to 2.3) |
|---|---|---|
| `mail off`: six addresses register 60 accounts | 60 emails in 49 s; then a real new customer: `verificationSent: false`, nothing in their inbox, "send it again" `sent: false` and one of their five tries used | 60 emails in 19 s; then the real new customer: **`verificationSent: true`, 1 email in their inbox**; "send it again": `sent: true` |
| `mail on` (stand-in) | the same as off | the same as off: sent, 1 email in the inbox |
| `mail-one off`: ONE address, 10 accounts, then "send it again" | 10 accounts, 50 resends, 60 emails in 254 s; the cap used up by one address | 10 accounts, **5** resends accepted (then refused per address), 15 emails in 309 s; the real new customer afterwards: sent, 1 email in the inbox |
| `mail-one on` | n/a in the re-review's table | the same: 15 emails, the new customer's email sent |
| Password reset for the same person | sent | sent |

The script's customer line reads `checkout: 403 email-unverified` in every run: the script never
opens the email it has now received, so that is the confirmation rule working, not the cap.

Not reached by the scripts and covered by permanent tests (`server/security/siteCaps.test.js`,
12 tests): past the lines an email is held, the answer says so (`verificationQueued: true` with
the message), it is sent when the hour turns with each address's first before anyone's second,
one address can have 3 waiting, and a fourth from that address is turned away without costing the customer one of the day's five.

### RR-11. The clean-up pass freezes the server; a save grows with the database (Medium)

**Root cause.** Above 80 % every new row set off a pass that read every quote in one go (2 to 3 s
at 54 MB) and found nothing it was allowed to remove, again and again. And a save rewrites the
whole file.

**Fix.**
- The pass plans from row *sizes* read from the row headers (`OCTET_LENGTH`), not from the rows;
  deletes in pieces of at most 40 ms with the event loop turning between them; and a pass that
  found nothing is not repeated for 5 minutes (`PRESSURE_BACKOFF_MINUTES`).
- With drafts capped per sender the pass now has something to remove, so it ends the pressure
  instead of circling it.
- `DB_MAX_MB` is 16 by default (section 6, point 1).

**Measured** (`stall-probe.js`, adapted with a dated comment: the probe fills the database from one
account, which the new allowances forbid, so they are lifted for the probe as its header says it
lifts the others):

| | Before (re-review, load 3 to 9) | After (quiet) |
|---|---|---|
| One save at 1 / 8 / 16 / 32 / 48 / 60 MB of database (`sizes`, limits lifted) | 2 / 13 / 29 / 54 / 83 / 155 ms (load 5.8 to 6.8) | 0 / 6 / 10 / 21 / 42 / 67 ms (load 1.0 to 2.1) |
| The default ceiling | 64 MB (derived) | 16 MB: a save is 10 ms quiet, 29 ms on the re-review's loaded machine |
| Database held at 13.5 MB of 16 while one address re-prices one quote three times a second (`held 13.5`) | at 54 MB of 64: 16 saves of 127 and 184 ms (median, two runs); 16 and 17 health samples over 100 ms; worst 382 and 1,349 ms | 88 re-prices, 17 saves of 8 to 9 ms; health median 2 ms, 90th percentile 2 to 3 ms, worst 30, 30 and 41 ms, no sample over 100 ms (three runs, load 0.3 to 2.2) |
| A clean-up pass above 80 %, set off by one small upload | the thread held 2.2 to 2.4 s, health worst 2.1 to 3.0 s, nothing removed, and again at the next row | run 2: the thread held 47, **110** and 31 ms at most in the three passes, health worst 41, 85 and 15 ms, the database from 13.5 to 10.4 MB. The 110 ms was the compaction (rebuild and write in one piece). They are two pieces now: run 3 held 36, **81** and 27 ms, health worst 21, 62 and 13 ms, 13.5 to 11.7 MB. (Run 1 came while every row was under two minutes old and only looked: 36 to 43 ms. It also showed that a pass which found nothing then slept its five minutes; fixed, with a test.) |
| A pass over 1,600 rows removing 1,013 (unit test) | n/a | longest piece 46 to 56 ms, event loop held 46 to 52 ms at most (four runs, load 1.4 to 1.5) |
| Server memory with the database at its ceiling | 598 and 716 MB at 54 MB | 266 to 342 MB at 13.5 to 16 MB |

What `DB_MAX_MB` keeps a save under 50 ms: quiet, the line is at about 52 MB. On the re-review's
loaded machine it is at about 30 MB (54 ms at 32 MB). The default is 16, where a save was 29 ms
even there, because nothing legitimate needs more at launch once drafts are capped per sender
(section 6, point 1). `held` at 54 MB with `DB_MAX_MB=64`, the
re-review's own size, could not be completed here: filling 54 MB through the server is several
thousand saves of a 40 to 54 MB file, and with this machine's disk stalling it had reached 45 MB
when the 20-minute limit stopped it.

A cost found and removed on the way: sizing a sender's rows read the rows themselves
(`LENGTH(CAST(... AS BLOB))`), so a one-line quote took 47 ms at 16 MB in `sizes` (where one
account holds everything) against 10 ms for the save. Sizes are now read from the row header
(`OCTET_LENGTH`): 1.6 ms instead of 12.4 ms per query on a 17 MB table.

### RR-07. Two customers, one refused for memory (Medium)

**Root cause.** Round 1 stopped "the largest file" when memory ran over, which is the customer's
2 MB STEP and not the 1 MB file that had taken the memory; and the re-run alone was measured
against the same line and from the same baseline, so a parse that only needed the room to itself
was refused.

**Fix** (`server/parsers/parsePool.js`):
- The parse to stop is the one that has taken the most memory: each worker is asked for its own
  figures (heap, typed arrays and WebAssembly memory, allocator). On a runtime that cannot be asked
  (Node 20: `worker.getHeapStatistics` arrived in 22.16), the ranking is by the memory each
  parser's thread has touched since its parse began (its page faults, from `/proc`). Figures
  within 64 MB of each other count as equal (then the larger file, then the longer-running parse),
  and a worker that is still starting counts as having taken nothing. Found this round: with 32 MB
  buckets, two near-equal workers on either side of a bucket edge had the customer picked.
- A stopped parse **waits its turn and runs again alone**, with idle workers released first and
  the baseline taken afresh. Running alone it has the whole parsing share (62 % of the budget, not
  half). It is refused `parse-memory` only if it passes that line, or the process's own line,
  **while running alone**. A customer beside a memory-hungry file is therefore delayed, never
  refused.
- **When the server, not the file, is short of room.** If a parse running alone is stopped by the
  process's own line while it has itself added less than the share two parses get (512 MB), the
  sender is asked to try again in a minute (the existing `busy` wording, 503 with `Retry-After`),
  is not marked, and the log says in capitals what happened and what to do. It is told
  `parse-memory` only when the parse itself is the size of the problem.
- All lines are judged on the resident memory of the process, because typed arrays and the CAD
  kernel's memory are not in the JavaScript heap.
- Reading limits are on the parser's CPU time, with a clock backstop of four times the limit
  (at most 120 s), so a busy machine does not turn a dense drawing into `parse-timeout`
  (RR-15 point 5).

| `MEMORY_BUDGET_MB` | Heap limit of one parser | Two or more parsing: growth allowed (`PARSE_RSS_LIMIT_MB`) | One parsing alone (`PARSE_RSS_SOLO_LIMIT_MB`) | Whole process (`PARSE_RSS_CEILING_MB`) |
|---|---|---|---|---|
| 1,024 (default) | 384 MB | 512 MB | 634 MB | 942 MB |
| 2,048 | 768 MB | 1,024 MB | 1,269 MB | 1,884 MB |
| 4,096 | 1,536 MB | 2,048 MB | 2,539 MB | 3,768 MB |

What fits at the default, measured on this branch on a quiet machine, one parse in a fresh process:

| File | Added to resident memory at the peak | Outcome at 1,024 MB |
|---|---|---|
| The repository's 2 MB STEP (400 holes) | about 460 MB | fits alone; two together do not, so the second waits and both are served |
| Closed mesh, 100,000 triangles (4.8 MB STL) | 176 MB | fits (it took 58 s to read: the mesh analyser's own cost on this branch, not changed here) |
| Closed mesh, 300,000 triangles (14 MB STL) | at least 361 MB (stopped by the clock at 120 s in my probe before it finished) | fits for memory; too slow to read on this branch |
| Closed mesh, 500,000 triangles (24 MB STL, the largest allowed) | over the parser's 384 MB heap after 5 s | `parse-memory`, as in round 1: sent to a person at this budget |

On `geometry-speed` a 500,000-triangle mesh peaks at 1.0 to 1.1 GB resident (the coordinator's
figure, not measured here), outside the heap: over every line at 1 GB, inside the solo line at
2 GB. So with that branch merged the choice is `MEMORY_BUDGET_MB=2048` on a 2 GB instance, or a
lower `MESH_MAX_TRIANGLES`, or accepting that the largest meshes go to a person.

**Memory that is not given back.** After a large parse the process keeps part of the memory the
parser used (freed inside the process, still resident): in a bare test process the resident size
after three STEP parses was 386, 456 and 488 MB against 71 MB at the start, and the live server
sat at 525 to 650 MB between rounds of `parse-pool.js pair 10`. Later parses reuse most of it, and
all 20 uploads of that run were served. But the process's own line is on resident memory, so a
server that has been pushed to about 480 MB resident with nothing running cannot take the 2 MB
STEP until it is restarted; it then says "try again in a minute", with the log line described
above. I tried the C allocator's settings (`MALLOC_ARENA_MAX=2`, a fixed mmap threshold): 383 MB
instead of 488 MB after the same three parses, one run each, not enough to call it fixed, and not
set anywhere. This is open (section 9).

**Before and after** (`parse-pool.js`):

| Script | Before (re-review, load 3 to 9) | After, quiet (load 0.4 to 2.0) | After, loaded with four busy loops (load 5.1 to 5.8) |
|---|---|---|---|
| `pair` (no attacker, two customers upload the 2 MB STEP at the same moment, 3 rounds) | one of the two refused `parse-memory` in 2 of 4 runs, and in 1 of 3 rounds of another | 6 of 6 served in each of two runs (8.5 to 16.1 s; the one that waited its turn is the 16 s one). A 10-round run: 20 of 20 served | 6 of 6 served (21 to 41 s) |
| `steal` (one address uploads a 1.25 MB 3MF that needs hundreds of MB while a customer uploads the STEP, 3 rounds) | the customer served 3 of 3, but the customer's parse was the one stopped | customer served 3 of 3 in 7.7 to 8.4 s against 6.9 to 8.1 s alone: never the one stopped. The hungry file was the one stopped every time (refused `parse-memory`, or asked to try again once the process itself was the limit) | not run |
| `steal` with the Node 20 path forced (ranking by memory touched) | n/a | customer served 3 of 3 (7.5 to 8.1 s), never the one stopped | not run |
| `solo` (two addresses with hungry files, then 20 customers) | 20 served, longest wait 21 s | 20 served, longest wait 16.5 s and 14.3 s (two runs); none refused | not run |
| `tools/security/availability-fixes/after-the-flood.js` (new: six hungry uploads, then four customers alone, one at a time) | n/a | 4 of 4 parsed in 6.7 to 7.0 s each; resident memory before each was 320 to 554 MB | not run |

### RR-09. Measurements that are finite but wrong (Medium)

**Root cause.** Round 1 checked that numbers were numbers. A mesh can be perfectly finite and
still lie: a shell hidden inside another cancels or adds volume, triangles counted several times
give a volume larger than the box, and a sheet a hundredth of a millimetre thick is a "part".

**Fix.**
- `server/parsers/meshShells.js` (new): the mesh's vertices are welded, its connected closed
  shells found, and a shell whose box lies inside another's is tested by ray casting. One closed
  shape inside another is refused with `nested-shells` and the firm-quote offer. Called from the
  STL checks and for 3MF (`inputGuards.js`; one line in `fileParser.js`, section 7).
- `server/parsers/saneGeometry.js`: a counted volume larger than the bounding box is
  `geometry-not-measurable`; for printing, a smallest side or an average wall (volume over half
  the surface) under 0.4 mm is `too-thin-to-print`.

**Before and after** (`geometry-price.js volume`, `small`):

| Model | Before: print / CNC | After |
|---|---|---|
| Honest 100 mm cube | $153.42 / $291.90, checkout open | the same, to the cent |
| Cube plus its inside-out copy (volume 0) | refused at upload | refused at upload (`geometry-not-measurable`) |
| Cube plus an inside-out cube 0.2 mm smaller, and 0.002 mm smaller | the second: **$100.10 print, checkout open** | both refused at upload: `nested-shells` |
| Cube with five cubes nested inside, all facing out (counted volume 5.16 times the box) | **$423.34 / $465.18, checkout open** | `nested-shells` |
| Thin frame, 4 mm bars (honest) | $20.11 print, checkout open / $414.94 CNC, sent to a person | the same, to the cent, and the same gate |
| The same frame with 60 closed shells hidden in one bar; and with 330 | 60: $105.86 / **$382.71 CNC, checkout open** | both `nested-shells` |
| Honest hollow cube with a sealed cavity (the script's control) | not in the re-review's table | `nested-shells`: sent to a person (section 6, point 7) |
| 100 x 100 x 0.011 mm sheet | **$19.59 print, checkout open** / $201.80 CNC, sent to a person | print: `too-thin-to-print`. CNC: $201.80, sent to a person, as before |
| 1,000 x 1,000 x 0.011 mm sheet | print priced | print: `too-thin-to-print`. CNC as before |
| 1 mm cube | priced, by design | print: `too-thin-to-print` (section 6, point 8). CNC $191.64, checkout open, as before |
| 0.99 mm cube, 0.009 mm sheet, 9,999 mm cube, a cube 99 m from the origin | refused, or priced and sent to a person | as before |

The shell check costs 18 to 265 ms for one closed shell of 100,000 to 300,000 triangles and 27 to
67 ms for two (in the worker, measured alone). A counted volume over the bounding box with no
nested shell (overlapping, not nested, bodies) is caught by the volume check at pricing.
`geometry-price.js units` (RR-10) is unchanged and not mine: still $149.25 paid for a $3,376.62 job.

### RR-06. A refused upload's connection (Low)

**Root cause.** The bytes read and thrown away after a refusal were not charged to anyone, and
the connection stayed a working HTTP connection, so a second request on it ran with no way to
answer. (Also found while fixing: the timer that closes the connection once the refused body has
ended was cancelled the moment the body ended, a round-1 slip; it is tied to the connection now.)

**Fix** (`server/security/uploadGuards.js`, first middleware in `server/index.js`): thrown-away
bytes are charged to the sender's day as they arrive; the connection is marked, and a second
request on it is not run (the connection is reset); a sender more than 256 MB past its day's
allowance gets 1 MB of reading-on instead of 64.

**Before and after** (`linger.js`; `pipeline` adapted with a dated comment to report the server's
own side of the close, because that script's client keeps its half open and cannot see it):

| | Before (re-review) | After (final commit, quiet, load 0.4 to 1.0; an earlier run of each gave the same within a few ms) |
|---|---|---|
| `hold`: server's side of the connection closed after | 5,026 to 5,059 ms in four stalling patterns | 5,028 to 5,033 ms in the three slow patterns; the fast sender (1 MB every 100 ms) had sent 50 MB when the 5 s were up and saw the close after 5,013 ms |
| `many`: 400 refused uploads held open at once | all closed; memory 129 to 158 MB; health median 2 ms, worst 1,261 ms (one sample) | all 400 answered and closed; memory 134 to 160 MB; open files 22 to 422 and back; health median 2 ms, worst 271 ms (340 ms in the earlier run). The clients, which send one byte a second, noticed the close after 7.06 to 7.08 s: a client that only writes learns of a close at its second write after it |
| `free`: bytes a refused upload sends without being charged (20 MB daily allowance) | 445 MB sent in four refused uploads, none charged; a real upload from the same address then passed | 262 MB sent, all of it charged; the upload afterwards is 429 `daily-upload-limit` |
| `pipeline`: a pricing request sent on the refused connection | **executed** (a draft was created), never answered | **not executed** (0 drafts before, 0 after), not answered; the server's side of the connection closed 202 ms after it was opened, that is as soon as the second request arrived |

The script's `connectionClosedAfterMs` in `pipeline` still reads 20 s. That is the script's own
client: it keeps its half of the connection open after the server's answer and does not read, so
it cannot see a close until its 20 s cap. The added `serverSideSocketClosedAfterMs` is the same
measurement `hold` already used.

### RR-12. The start-up key check went quiet (Low)

**Root cause.** It read the 25 newest encrypted files per folder.
**Fix.** It reads the header of every encrypted file (12 µs each here: 61 ms for 5,000 files;
past 20,000 in a folder, the oldest and newest 10,000).
**After** (`encryption.js`): After 30 new uploads under the new key and a restart, the start-up error is printed (`afterNewUploadsUnderTheNewKey.startupErrorPrinted: true`) while the old parts are still locked. The message now counts all files ("8 of the 10 encrypted files on the volume")

### RR-15. Accuracy of the round-1 write-up (Info)

1. Best-case numbers stated as results: corrected in place in
   `docs/security/availability-fixes-2026-11-11.md`, each marked "Corrected 2026-11-12", with a
   note at the top (the 1,574 quotes and 53 addresses, the pricing table, "3 of 3 served", "a few
   hundred addresses").
2. "The pass runs at once when a request is refused": it now does for a refused quote as well.
3. `botCheck.test.js`: left alone as instructed.
4. `tools/security/review/`: my round-1 hand-over named a folder that does not exist; the scripts
   are in `tools/security/review-uploads/`, as the write-up's section 11 has it.
5. The 10 s limit for a DXF failing under load: the limit is on CPU time now (RR-07 above).

## 3. New settings

All in `server/security/limits.js`, all appended to `.env.example` with a one-line meaning. A
default that changed is marked.

| Setting | Default | What it is |
|---|---|---|
| `ALLOW_LAUNCH_WITHOUT_BOT_CHECK` | unset | `1` lets production start without the Turnstile keys |
| `QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR`, `QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR` | 120, 120 | seconds of pricing work one address / one account may use in an hour |
| `QUOTE_PRICE_LIGHT_KB`, `QUOTE_PRICE_LIGHT_MS` | 256, 150 | what counts as a light quote; when a light quote moves to the heavy lane |
| `QUOTE_PRICE_HEAVY_BURST_MS`, `QUOTE_PRICE_HEAVY_DUTY_PERCENT` | 1000, 33 | full-speed burst and then share of the thread for heavy quotes |
| `QUOTE_PRICE_QUEUE_MAX`, `QUOTE_PRICE_QUEUE_WAIT_MS` | 200, 15000 | quotes that may wait for the runner, and for how long |
| `QUOTE_REPRICE_PER_QUOTE_HOUR` | 300 | re-prices of one quote in an hour |
| `QUOTE_DRAFT_KB_PER_CLIENT`, `QUOTE_DRAFT_KB_PER_ACCOUNT` | 512, 512 | stored draft quotes one address / one account may hold |
| `DRAFT_KEEP_KB_PER_HOLDER` | 64 | nobody is taken below this by the clean-up |
| `LOOSE_PARTS_KEEP_PER_HOLDER` | 10 | uploads on no quote that a sender keeps under database pressure |
| `CUSTOMER_PART_KEEP_MINUTES` | 60 | a signed-in customer's upload is never cleared before this |
| `PRESSURE_BACKOFF_MINUTES` | 5 | wait after a pass that found nothing (shorter if something spared for being new matures sooner) |
| `DB_MAX_MB` | **16** (was derived: 64 at 1 GB) | database ceiling |
| `DRAFT_SWEEP_MIN_AGE_MINUTES` | **2**, from creation (was 30, idle) | a row this new is not removed by the clean-up |
| `STORAGE_EVICT_MIN_AGE_MINUTES` | **2**, from upload (was 30, idle) | the same for a file |
| `UPLOAD_STORED_MB_PER_IP` | **150** (was 400) | files one address may have stored |
| `UPLOAD_STORED_MB_PER_ACCOUNT` | 150 | files one account may have stored |
| `UPLOAD_PROTECTED_MB_PER_HOLDER` | a third of the stored allowance (50) | what unpaid or unanswered things keep safe from the clean-up |
| `ORDER_UNPAID_PROTECT_HOURS` | 48 | an unpaid order protects its files fully for this long |
| `RFQ_UNVERIFIED_FREE_PER_CLIENT_HOUR` | 2 | requests per address per hour outside the site-wide cap |
| `MAIL_UNCONFIRMED_FREE_PER_CLIENT_HOUR` | 2 | emails per address per hour outside the site-wide cap |
| `MAIL_UNCONFIRMED_HARD_PER_HOUR_SITE` | 300 | past this even those are held |
| `MAIL_HELD_PER_CLIENT` | 3 | emails held for later per address |
| `VERIFY_RESEND_PER_CLIENT_HOUR` | 5 | "send it again" per address per hour |
| `PARSE_WALL_FACTOR`, `PARSE_WALL_TIMEOUT_MS` | 4, 120000 | clock backstop for a reading limit that is now on CPU time |
| `PARSE_RSS_SOLO_LIMIT_MB` | 62 % of `MEMORY_BUDGET_MB` (634) | memory one parse running alone may add |
| `PARSE_RSS_CEILING_MB` | 92 % of `MEMORY_BUDGET_MB` (942) | resident memory of the process at which parsing gives way |
| `GEOMETRY_MIN_PRINT_WALL_UM` | 400 | thinnest printable part |

No longer used: `QUOTE_PRICE_MAX_INFLIGHT` (the site-wide count of pricing requests) and
`DRAFT_SWEEP_URGENT_MIN_AGE_MINUTES`. Both are still read without error if set.
`PARSE_TEST_DELAY_MS`, `PARSE_TEST_DELAY_EXT` and `PARSE_MEMORY_RANKING` are test-only and are
ignored unless `SE_TEST_HOOKS=1`, which production warns about at start.

## 4. Who can hold how much of what

"Sender" means an address (an IPv4 address or an IPv6 /64) or an account; both are counted, and
the smaller allowance applies. Every figure is a default and every one is a setting.

| Shared thing | Its ceiling | One sender's share | Checked | Ten senders at their full share | Senders needed to reach the first line that refuses anyone | What happens there |
|---|---|---|---|---|---|---|
| Draft quotes in the database | `DB_MAX_MB` 16 MB; clean-up at 80 %, no-account visitors refused at 85 % | 512 kB as stored per address (`QUOTE_DRAFT_KB_PER_CLIENT`) and per account (`QUOTE_DRAFT_KB_PER_ACCOUNT`) | on every new draft and on every re-price that grows a row | 5 MB, 32 % | at the full 512 kB each: 25 to reach the clean-up line, 27 to reach 85 %. Within one hour, at 30 new drafts an address: 57 (measured, `db-ceiling.js anon 16`) | the clean-up takes from the heaviest holder down to 64 kB each (`DRAFT_KEEP_KB_PER_HOLDER`); to hold 85 % after it, about 210 senders are needed, each keeping 64 kB |
| Re-pricing one quote | none | 300 an hour per quote (`QUOTE_REPRICE_PER_QUOTE_HOUR`) | on every re-price | n/a | n/a | `reprice-limit`, with the time to come back |
| New drafts | none | 30 an hour and 120 a day per address, 60 and 240 per account, as before | on create | n/a | n/a | `quote-limit`, as before |
| Pricing time on the one thread | heavy quotes together get a third of the thread after a 1 s burst (`QUOTE_PRICE_HEAVY_DUTY_PERCENT`, `QUOTE_PRICE_HEAVY_BURST_MS`) | 120 s an hour per address and per account (`QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR`, `_PER_ACCOUNT_HOUR`) | every piece of pricing work is charged as it is done | cannot take more than the heavy share between them | none: light quotes never wait behind heavy ones | over the allowance: `pricing-budget` with the minutes to wait; line full: `pricing-busy` |
| Stored files | `UPLOAD_DIR_MAX_MB` 2,048 MB; clean-up at 80 %, no-account visitors refused at 85 % | 150 MB stored per address (`UPLOAD_STORED_MB_PER_IP`) and per account (`UPLOAD_STORED_MB_PER_ACCOUNT`) | on every upload, at the door | 1,500 MB, 73 % | 11 to reach the clean-up line, 12 to reach 85 % | the clean-up takes from the heaviest holder first; what nothing refers to goes entirely |
| Files kept safe from the clean-up by something unpaid or unanswered (a request nobody has taken up, a saved quote, an order not paid after 48 h) | the same ceiling | 50 MB per holder (`UPLOAD_PROTECTED_MB_PER_HOLDER`, a third of the stored allowance) | by the clean-up | 500 MB, 24 % | 35 to hold 85 % with such material | beyond 50 MB the holder's oldest such files are cleared, heaviest holder first |
| A signed-in customer's upload in its first hour | the same ceiling | the account's 150 MB | by the clean-up (`CUSTOMER_PART_KEEP_MINUTES`) | 1,500 MB, 73 % | 12 accounts, each with a confirmed mailbox and its own address, hold 85 % for at most an hour | after the hour their files are ordinary files |
| Files on a paid order, or on a request the shop has taken up | the same ceiling | not capped | n/a | n/a | n/a | never cleared by the server |
| Requests from senders who did not pass the robot check | 30 an hour for the site (`RFQ_UNVERIFIED_PER_HOUR_SITE`) | each address's first 2 an hour are outside the cap (`RFQ_UNVERIFIED_FREE_PER_CLIENT_HOUR`); the existing per-address limit still applies | on every request | they use up the 30 between them | cannot be reached: nobody's first two are refused | a third request in the hour from one address, once the 30 are used: `requests-paused`, worded as before |
| Email to addresses nobody has confirmed | 60 an hour for the site (`MAIL_UNCONFIRMED_PER_HOUR_SITE`), 300 an hour hard (`MAIL_UNCONFIRMED_HARD_PER_HOUR_SITE`) | each address's first 2 an hour are outside the 60 (`MAIL_UNCONFIRMED_FREE_PER_CLIENT_HOUR`); "send it again" 5 an hour per address (`VERIFY_RESEND_PER_CLIENT_HOUR`) on top of the per-account limits; 3 held per address (`MAIL_HELD_PER_CLIENT`) | on every send | they use up the 60 between them | 150 addresses in an hour reach the hard line | over a line the email is held and sent when the hour turns; the customer is told so. Nothing is dropped unless one address already has 3 waiting |
| Parsing memory | `MEMORY_BUDGET_MB` 1,024 | see section 2, RR-07 | by the watchdog, on resident memory | n/a | n/a | a parse is refused for memory only after a clean run by itself |
| Bytes read from a refused upload and thrown away | none | charged to the sender's day (`UPLOAD_DAILY_MB_PER_IP`); the full reading-on (64 MB, 5 s) for the first 256 MB past the allowance, then 1 MB per refused request | as they arrive | n/a | n/a | the connection is closed |

What this table does not promise: with the robot check off, a few dozen addresses that cost nothing
(a rented block, a botnet) can still reach the lines above. The limits make each address small and
make the clean-up take from the flood first; they do not make addresses scarce. That is what the
robot check is for, and production now refuses to start without it unless the owner says so
(RR-03).

## 5. New refusals and their wording (for the message catalogue)

| Code | HTTP | When | What the customer reads | Way out offered |
|---|---|---|---|---|
| `pricing-budget` | 429, `Retry-After` | the address or account has used its hour's pricing time | "We've priced as much from this network or account in the last hour as the instant quote allows. It will price again in about N minutes. For a price sooner, send us the files for a firm quote (email) or call (phone)." | firm quote (`offerRfq`), wait |
| `drafts-full` (no account) | 429, `Retry-After` 600 | the address holds its allowance of draft quotes and has none idle to replace | "There are a lot of quotes open from this network. Keep working on one you already have open, or sign in to save more. For a big job, email the files to (email) or call (phone) and we'll quote it by hand." | keep working, sign in, email, phone |
| `drafts-full` (account) | 429 | the account holds its allowance of saved quotes | "Your account has as many saved quotes as we keep for one account. Open one you already have and change it, or email (email) and we'll clear out the old ones or quote the job by hand." | open an existing one, email |
| `reprice-limit` | 429, `Retry-After` | one quote re-priced more than 300 times in an hour | "This quote has been changed a great many times in the last hour. Give it a few minutes and it will price again, or email the files to (email) and we'll quote it by hand." | wait, email |
| `stored-limit` (account wording) | 429 | the account stores its allowance of files | "Your account has reached what we keep for one account at a time (150 MB of files). Files that are not on an order are cleared after a few days. Email your files to (email) or call (phone) and we'll quote them by hand." | email, phone |
| `nested-shells` | 422 at upload | an STL or 3MF holds one closed shape inside another | "This model has one closed shape inside another (a sealed hollow, or a part inside a part). The instant quote can't price that reliably, so we quote these by hand: email the file to (email) and we'll come back with a price." | firm quote (`offerRfq`) |
| `too-thin-to-print` | 422 at pricing | a printed part's smallest side, or its volume over half its surface, is under 0.4 mm | "This part is too thin or too small for our printers to make it reliably. Thicken it, or send it to us and we'll look at how it could be made (email)." | firm quote (`offerRfq`) |
| `geometry-not-measurable` (existing code, new case) | 422 | the counted volume is larger than the box the part fits in | existing wording ("We couldn't measure this model ...") | firm quote |
| `busy` (existing code and wording, new case) | 503, `Retry-After` 60 | a parse running alone was stopped because the server itself was short of memory, not because the file is large | "We're reading a lot of files right now. Give it a minute and upload this one again." | try again |
| `pricing-busy` (existing code, new cause) | 503, `Retry-After` 5 | more than 200 quotes are waiting for the pricing runner, or one waited 15 s | "We're pricing a lot of quotes right now. Try again in a few seconds, or call (phone)." | try again, phone |
| confirmation email held (not a refusal: 201 / 200 with `verificationQueued: true` or `queued: true`) | n/a | the site is over its hourly lines for mail to unconfirmed addresses | "We're sending a lot of confirmation emails right now. Yours is in line and will arrive within the hour; you don't need to ask again." | nothing to do |
| `rate-limited` (existing code, new case: "send it again" per address) | 429 | more than 5 "send it again" from one address in an hour | "We've sent several confirmation emails from this network in the last hour. Check the spam folder, and try again later; if it isn't arriving, (call us wording)." | wait, phone |
| start-up refusal (operator, not customer) | exit 1 | production, no Turnstile keys, no waiver | one line naming the two missing settings and `ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1` | set the keys, or the waiver |

All were run through `node scripts/claims-check.js` (exit 0).

## 6. Judgment calls

Each of these is a choice somebody could reasonably make the other way. Each is a setting unless it
says otherwise.

1. **`DB_MAX_MB` is 16 by default, and no longer follows `MEMORY_BUDGET_MB`.** A save rewrites the
   whole file on the one thread: about 1 ms per MB on a quiet machine and 2 to 3 ms per MB on the
   re-review's loaded one (section 2, RR-11). At 16 MB a save was 10 ms quiet and 29 ms loaded; it
   crosses 50 ms at about 52 MB quiet and 30 MB loaded. With drafts capped per sender, the launch
   database (catalogue, accounts, orders, a few hundred drafts) is a few MB. Real orders will grow
   it past 16 MB in time: at 13 MB the status page shows 80 %, and that is when to raise it,
   knowing each added MB adds 1 to 3 ms to every save. The lasting answer is a database that does
   not rewrite itself on every save (still open, section 9).
2. **One sender may store 150 MB of files at once, not 400.** At 400, five and a bit addresses
   reached the ceiling. At 150 it takes eleven to reach even the clean-up line. A customer with a
   larger job is told so in plain words and offered email.
3. **The clean-up no longer asks "who was idle longest" but "who holds the most".** Idle age was
   the thing the flood controlled (it kept its own rows fresh), so it protected the flood and
   exposed the visitor who had gone for coffee. What a row is still spared for is short and fixed:
   two minutes from creation (so nothing is removed while it is being made), and a signed-in
   customer's upload for its first hour.
4. **An account's own drafts can be removed under pressure**, down to its newest 64 kB, when no
   order or request came from them. Before, an account's drafts were never removed, which made one
   free account the way to fill the database for 30 days. A real customer who is not the heaviest
   holder is not touched; one who is, keeps the quotes they touched last.
5. **Files held by something unpaid or unanswered can be cleared beyond 50 MB per holder**: files
   on a request nobody at the shop has taken up yet (status "new"), on a saved quote, or on an
   order still unpaid after 48 hours. The saved quote is deleted with its file (it could not be
   priced or ordered without it). A request's row is kept and only its attachment goes, marked as
   removed, so the shop still sees who asked. This only happens when the file folders are past
   80 % and that holder is the heaviest. The alternative was RR-08: five addresses pinning the
   ceiling with one request each.
6. **Cancelled and expired orders protect nothing.** The names are the ones the order-lifecycle
   branch writes (`cancelled`, `expired`); `pending_payment` protects fully for 48 hours and then
   counts as "unpaid". There is no order status "closed" in either branch, so none is listed.
7. **A model with a closed shape inside another goes to a person**, including an honest hollow
   part with a sealed cavity. The file cannot say whether the inner shell is a void or a second
   body, the price differs by the whole inner volume either way, and a sealed cavity cannot be
   machined anyway. Open pockets, through-holes and frames are unaffected (the vetting run is
   identical).
8. **"Too thin to print" uses two measures**: the smallest side of the box, and volume divided by
   half the surface area (the average wall of a sheet-like part), each against 0.4 mm
   (`GEOMETRY_MIN_PRINT_WALL_UM`). The second is an average, not a true minimum wall: a part with
   one thin fin and a thick body passes it, and a 1 mm cube fails it (0.33 mm), which is right for
   a printer and is not applied to machining. It runs only when the process is printing.
9. **Heavy quotes share a third of the thread.** After one second at full speed, quotes whose
   parts carry more than 256 kB of stored detail get 33 % of the time between them and rest in
   between. A customer with a genuinely heavy 25-line quote waits about three times as long for
   it when others are doing the same; everything light (the usual quote) is not behind them at
   all. One heavy line that cannot be cut into pieces (about 0.1 s for a 4,900-hole sheet) is the
   longest anything waits.
10. **The pricing allowance is 120 seconds of work an hour** per address and per account. An
    ordinary quote costs a few milliseconds; a customer re-pricing a 25-line quote of dense
    drawings uses about a second each time and would have to do that 120 times in the hour.
11. **Mail over the hourly line is held, not dropped, up to 300 an hour, 3 per address, and for at
    most a day.** The queue is in memory: a restart loses what is waiting (the customer can ask
    again, and the page says the email is on its way, not that it has been sent).
12. **Reading limits are on the parser's own CPU time**, read from the operating system per
    thread, with a clock limit of four times that (never more than 120 s) so a starved machine
    cannot hold a slot forever. On a quiet machine nothing changes. On a busy one a legitimate
    dense drawing is no longer refused because other work took the CPU (RR-15 point 5); the price
    is that a parse can sit in a slot up to four times as long.
13. **A parse running alone may use 62 % of the memory budget, two together half of it**, and the
    whole process has a line at 92 %. All three are judged on resident memory of the process, not
    on the JavaScript heap, because typed arrays and the CAD kernel's memory are outside the heap.
14. **Production does not start without the robot check keys** unless
    `ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1` is set. Every script and document that starts the server in
    production mode without keys needs that setting from now on (section 7).
15. **Stored quote lines are compressed, not reduced to inputs plus price.** See RR-01 in
    section 2: the full cost build-up is read from the stored line by the order, the documents,
    the gate and the request form, so dropping it is not a contained change.
16. **A sender far past the day's upload allowance gets a short reading-on.** The reading-on after
    a refusal exists so a browser shows our answer instead of "connection reset". It is kept in
    full for the first 256 MB a sender throws away past the allowance (a customer who runs into
    the limit a few times), then cut to 1 MB per refused request.

## 7. Merge notes

- **Reorder (`server/routes/orders.js`, not edited here).** The gate and the runner are exported.
  The route becomes `async`, takes `pricingGate.admit()` after `authenticate`, and both `saveQuote`
  calls (the first try and the "standard lead time" retry) go through
  `pricingMemo.run(() => saveQuote(body, req.user, pricingGate.context(req)), pricingGate.job(req, configs))`.
  Two things beyond those two lines. First, the existing `catch` retries any refusal with the
  standard lead time: a refusal about load or allowances (HTTP 429 or 503, or code
  `quote-too-slow`) must be answered as it is, not retried and not turned into `reorder-failed`.
  Second, the route checks that each line's part still exists with `partsDB.getById`, which reads
  the part's whole measurement file, once per line, before any pricing starts (0.7 s of held
  thread for 100 lines of a dense part, measured): `partsDB.getRow` answers the same question from
  the row. The exact change I measured with (section 2, RR-05) is:

  ```js
  router.post("/:id/reorder", authenticate, require("../security/pricingGate").admit(), async (req, res) => {
    …
      .filter((it) => it.partId && partsDB.getRow(it.partId))   // was partsDB.getById
    …
    const pricingGate = require("../security/pricingGate");
    const priced = (body) => require("../services/pricingMemo").run(() => saveQuote(body, req.user, pricingGate.context(req)), pricingGate.job(req, configs));
    const passOn = (err) => { if (err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds)); return res.status(err.status).json({ error: err.message, ...(err.extra || {}) }); };
    const aboutLoad = (err) => err.expose && (err.status === 429 || err.status === 503 || (err.extra && err.extra.code === "quote-too-slow"));
    try { result = await priced({ ...input, leadTimeSlug: order.leadTimeSlug || "standard" }); }
    catch (err) {
      if (!err.expose) throw err;
      if (aboutLoad(err)) return passOn(err);
      try { result = await priced({ ...input, leadTimeSlug: "standard" }); }
      catch (err2) { if (!err2.expose) throw err2; if (aboutLoad(err2)) return passOn(err2); return res.status(409).json({ … "reorder-failed" }); }
    }
  ```
- **`server/parsers/fileParser.js` (geometry lane): one line changed**, in `parse3MF`, where the
  vertices of the whole build are checked:
  `inputGuards.assertFiniteVertices(allVertices, { shells: true });` (was without the second
  argument). On `geometry-speed` that function was restructured; the call to re-apply is the one
  that checks the 3MF's merged vertex list before it is analysed. For STL nothing in that file
  changed: the check is inside `inputGuards.checkBinaryStl` and `checkAsciiStl`, which the worker
  already calls before parsing. `server/geometry/dxf/parse.js` is untouched.
- **`server/routes/api.js`, the one line inside `priceQuote`**: `assertSaneGeometry(part.geometry, { partId: config.partId, fileName: part.fileName, config });`
  (the `config` is new: the thin-print check needs the process).
- **Order states.** Retention reads `ORDER_OVER = ["cancelled", "expired"]` and
  `ORDER_UNPAID = ["pending_payment"]` in `server/services/rowRetention.js`. The order-lifecycle
  branch sets `expired` on an unpaid order and puts its quote back to `draft`; both line up with no
  change. If that branch adds a state for an unpaid order that is over, add it to `ORDER_OVER`.
- **Production-mode starters need `ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1` or the keys**:
  `server/testSupport/liveServer.js` and `scripts/e2e/hardening-accounts.mjs` are done. Not done
  (other lanes' files): the command in `docs/quote-vetting-process.md` step 2, any QA script that
  runs `NODE_ENV=production node server/index.js` by hand, and the Railway service itself, where
  the deploy will fail with a one-line reason until the keys or the waiver are set.
- **Schema, additive only**: `quotes.client_tag`, `quotes.part_ids`, `parts.owner_id`
  (`server/models/database.js`, field maps in `SqliteDB.js`). Stored quote lines are now written
  compressed (`{ $lines: 2, n, z }`); both earlier forms are still read. Code that reads
  `quotes.lines` straight from the table instead of through `quotesDB` must use
  `quotesStore.unpackLines`.
- **Tests that were tied to a slow drawing** now use the test delay (`PARSE_TEST_DELAY_MS`,
  `PARSE_TEST_DELAY_EXT`, honoured only with `SE_TEST_HOOKS=1`): `server/parsers/parseFairness.test.js`,
  `server/parsers/parsePool.test.js` ("a small file that is slow to read") and one line of
  `server/security/uploads.test.js` (the server's settings in "a slow file is cut off", 60 lines
  above the 250 ms assertion, which I did not touch). `server/routes/botCheck.test.js` is untouched.
- **`geometry-speed` and memory.** The watchdog already judges resident memory. A 500,000-triangle
  mesh that peaks at 1.0 to 1.1 GB resident there is over every line of a 1 GB budget (section 2,
  RR-07 table): with that branch merged, either `MEMORY_BUDGET_MB` is 2048 on a 2 GB instance or
  `MESH_MAX_TRIANGLES` comes down, or such a mesh is (correctly, after a clean run alone) sent to a
  person. The shell check adds one hash table of the vertices in the worker, outside the heap.

## 8. Every run

The machine: 2 cores, Node 22.23 (Node 20 is not installed here), the sandbox the re-review used,
quiet this time (no other agents). "Loaded" means four busy loops running beside the test (load
average 4.6 to 5.8), which is about the load the re-review worked under. The disk of this machine
stalled repeatedly during the afternoon (the kernel's "full" IO pressure counter went from 79 s to
334 s); where that touched a run it is said. Each line is one run unless it says otherwise.

The code changed while the runs were made (the commits of this round are listed at the end). A run
is listed against the final code if nothing it exercises changed afterwards; the four `linger.js`
runs and `npm test` were repeated on the final commit for that reason.

### The re-review's scripts (`tools/security/rereview-availability/`)

| Script | Its "passing fix" line | Result | Meets it | Load |
|---|---|---|---|---|
| `pricing-eight.js` (3 runs: quiet, quiet, loaded) | health median in single figures; the other visitor keeps getting prices | health median 2 ms quiet, 8 to 9 ms loaded; the visitor priced on every try. Run 1 had one 19.9 s stall (section 2) | Yes (run 1's stall reported, not explained) | 0.6 to 1.6; 4.6 to 4.7 |
| `reorder-block.js` as the branch stands | health worst in the tens of ms; a second reorder waits or is told to retry | reorders 3.0 to 3.8 s, health median 2.4 s during them: unchanged, the route is not edited here | **No** (integration) | 1.3 |
| `reorder-block.js` with section 7's change applied for the run | the same | reorders 51 to 62 ms; health worst 12 ms during them, 40 ms with four at once; the fourth of four told to retry (429). With only the gate and runner (without the `getRow` line): 0.7 to 0.9 s a reorder and health median 426 ms, because the route reads each part's whole measurement file once per line | Yes, with all three lines | 1.1 to 1.3 |
| `db-ceiling.js size` | n/a (a measurement) | 12,288 bytes for 25 different lines; 16,384 for 100 | n/a | 1.2 |
| `db-ceiling.js account` (8 MB and 16 MB) | the victims end with 200 | 200, 200, 200, also after the pass and after a restart | Yes | 0.8 to 1.7 |
| `db-ceiling.js grow` (8 MB and 16 MB) | the victims end with 200; a re-price past its share is refused like a new row | 200, 200, 200; database at 8 % and 4 %. The refusal itself is in the unit test (the script's 30 drafts stay inside one sender's allowance) | Yes | 1.3 to 1.4 |
| `db-ceiling.js anon` (8 MB, 8 MB with the stand-in check, 16 MB) | n/a (counts addresses) | 29, 29 and 57 addresses to the pause; confirmed customers served | n/a | 1.2 to 1.4 |
| `eviction-collateral.js` | the visitor's quote is 200 and the customer's part prices, or the flood's drafts are the ones removed | both: 200, 200, and 190 of the flood's drafts removed | Yes | 0.3 |
| `site-caps.js rfq off`, `rfq on` | the visitor's request afterwards is 201 | 201 and 201 | Yes | 1.2 to 1.3 |
| `site-caps.js mail off`, `mail on`, `mail-one off`, `mail-one on` | the new customer's `verificationSent` is true | true in all four, 1 email in their inbox | Yes | 0.0 to 2.0 |
| `storage-pin.js pin`, `control` | after the pass customers upload again without the owner deleting anything | 71 %, both accepted, in both | Yes | 0.2 to 0.4 |
| `stall-probe.js sizes` (adapted, dated comment) | the save stays flat as the database grows | 0 / 6 / 10 / 21 / 42 / 67 ms at 1 / 8 / 16 / 32 / 48 / 60 MB: it does not stay flat. The save is not changed; the ceiling is 16 MB | **No**: contained, not fixed | 1.0 to 2.1 |
| `stall-probe.js storm` (quiet, loaded) | n/a | health median 1 ms and 2 ms; worst 138 ms and 319 ms | n/a | 0.7; 4.9 |
| `stall-probe.js held 13.5` (the default ceiling; 3 runs) | n/a | health worst 30 ms while re-pricing; passes hold the thread 36 to 43 ms (run 1, looked only), 47 / 110 / 31 ms (run 2), 36 / 81 / 27 ms (run 3, compaction in two pieces) | n/a | 0.3 to 2.2 |
| `stall-probe.js held 54` with `DB_MAX_MB=64` | n/a | not completed: stopped by the 20-minute limit at 45 MB, the disk stalling | n/a | 2.1 |
| `parse-pool.js pair` (quiet twice, 10 rounds once, loaded once) | no customer refused | 6 of 6, 6 of 6, 20 of 20, 6 of 6 | Yes | 1.3 to 1.9; 5.1 to 5.8 |
| `parse-pool.js steal` (twice; once more with the Node 20 ranking forced) | the customer is never the parse stopped, and parses every round | 3 of 3 each time; the hungry file is the one stopped | Yes | 0.9 to 1.3 |
| `parse-pool.js solo` (twice) | n/a | 20 customers served, longest wait 16.5 s and 14.3 s | n/a | 0.8 to 1.2 |
| `linger.js hold` | closed at or under 5 s (6 s when the body ended) | server's side closed after 5,028 to 5,033 ms in the three slow patterns; the fast sender saw the close at 5,013 ms | Yes | 0.4 to 1.0 |
| `linger.js many` | the same | 400 of 400 answered and closed, none open after 40 s; health median 2 ms, worst 271 ms | Yes on the server's side; the clients' own view is 7.1 s (section 2) | |
| `linger.js pipeline` (adapted, dated comment) | `pipelined.executed` is false | `executed: false` (0 drafts before and after); server's side closed after 202 ms | Yes | |
| `linger.js free` | thrown-away bytes are charged | 262 MB sent in four refused uploads, all charged; the upload afterwards is 429 `daily-upload-limit` | Yes | |
| `geometry-price.js volume`, `small` | every hostile row refused or sent to a person | all refused at upload or at pricing (section 2) | Yes | 0.3 to 0.4 |
| `geometry-price.js units` | (RR-10) | $149.25 paid for a $3,376.62 job, as in the re-review | **No** (integration) | 0.4 |
| `encryption.js` | the start-up error is printed after new uploads under the new key | `startupErrorPrinted: true`, old parts still locked; every other check of the script as in the re-review | Yes | 0.4 |
| `memo-check.js` | (RR-14, and the memo checks) | `problems: []`; 0 wrong prices in the concurrent pairs; reorder of one part in two thicknesses still comes back in one ($257.82 for $246.82): RR-14, not mine | n/a | 0.4 |
| `preview-access.js off`, `on` | (access checks) | `leaks: []` in both | n/a | 0.4 to 0.5 |
| `migration.js` | (migration checks) | additive: no table or column lost; second start changes nothing and the file is byte-identical; master's parts price the same ($892.92 then, $892.91 now, whole cents) | n/a | 0.4 |
| `vetting-compare.js` | `rowsThatDiffer` is 0 | base `hardening-2026-11-11` (e4881d3) 300 quotes, this branch 300 quotes, `rowsThatDiffer: 0` | Yes | 0.9 |

Adapted scripts, each with a dated comment in the file and none to an easier case:
`stall-probe.js` lifts the two new per-sender draft allowances and the pricing-time allowance for
its `sizes` and `held` measurements (it already lifted the other limits on new drafts to build its
database from one account); `linger.js pipeline` also reports the server's own side of the close,
measured the way `linger.js hold` does.

### Tests and checks

| What | Result | Load |
|---|---|---|
| `npm test` on the final commit | 51 of 51 suites passed (commit `2f82141`). The run before it, one commit earlier, was 50 of 51: `server/routes/accountSecurity.test.js`, "the confirmation can be re-sent ... five times a day", failed because my RR-04 change had stopped charging the day's attempt when nothing was sent. That was a weakening of an existing limit; the charge is back (section 2, RR-04) and the test is unchanged. `botCheck.test.js` and the 250 ms assertion in `uploads.test.js` passed in both runs on this quiet machine | 0.6 to 1.5 |
| `NODE_ENV=production npm run build` | 22/22 routes rendered, 22 JSON-LD blocks valid | 1.4 |
| `node scripts/claims-check.js` | exit 0 (run after each wording change) | 0.4 to 1.4 |
| Vetting, 300 quotes, against the CSV made before any round-2 change (quote-id column blanked) | 300 quotes, 0 fails and 63 warnings as before; **0 of 300 rows differ** | 0.6 |
| `scripts/e2e/hardening-accounts.mjs --shots <scratch>` | 96 of 96 checks passed, no Content-Security-Policy violation, no console error; screenshots written to a scratch folder, none committed | 0.7 to 0.9 |
| `tools/security/csp-browser-check.js` | not run | n/a |
| New and changed suites | `server/services/senderQuotas.test.js` 9, `server/services/storagePressure.test.js` 13, `server/routes/pricingAvailability.test.js` 8, `server/security/siteCaps.test.js` 12, `server/security/botCheckStartup.test.js` 3, `server/security/linger.test.js` 3, `server/parsers/parsePool.test.js` 16, `server/parsers/parseFairness.test.js` 8, `server/parsers/saneGeometry.test.js` 12, `server/services/fileCrypto.test.js` 5, `server/models/masterDatabase.test.js` 3 | in `npm test` |

Measured once, or only in one condition, and to be read that way: the 19.9 s stall (once, not
reproduced); the 110 ms compaction piece (once, before it was split in two); the mesh memory
figures of RR-07 (one parse each, quiet); the allocator experiment (one run each way); `after-the-flood.js`
(one run, quiet); the loaded runs (one each, with synthetic load, not the re-review's real
neighbours); everything on Node 22 only.

## 9. Still open

| What | Why it is open | Whose |
|---|---|---|
| The reorder route is not behind the pricing gate on this branch | Not mine to edit; the gate and runner are exported and the exact change is in section 7. Measured with that change applied and then reverted (section 2, RR-05). Until it is merged, RR-05 is as the re-review found it | integration |
| RR-10 (units switched after pricing), RR-14 (reorder keeps one configuration per part) | Not in this work | integration |
| With the robot check off, a few dozen free addresses can still reach a shared line | Section 4 gives the counts: 25 to 27 for the database lines, 11 to 12 for the file lines, 35 to pin files with requests or saved quotes. The clean-up then takes from them first and a visitor's first actions are not refused, but while the flood is running, visitors without an account can be asked to sign in or email. Production refuses to start without the keys unless told to | owner: set the Turnstile keys |
| A save still rewrites the whole database on the one thread | Not changed (it is the storage engine). Contained by the 16 MB default; 1 to 3 ms per MB. Raising `DB_MAX_MB` buys room at that price | owner / a later change of engine |
| The compaction at the end of a database clean-up is one piece of work | It cannot be cut up. Its time grows with the database: see section 2, RR-11, for what it measured at the default ceiling and at 64 MB | as above |
| One heavy line cannot be cut into pieces | A line of a very dense part is priced in one go (about 0.1 s for 4,900 holes here). It is the longest single hold in pricing | geometry-speed makes the line itself cheaper |
| The process keeps memory after large parses, and its line is on resident memory | Section 2, RR-07. At the default 1 GB budget a server that has done many large parses can reach the point where a 460 MB parse is asked to try again later; a restart clears it. More room (`MEMORY_BUDGET_MB=2048` on a 2 GB instance) is the plain answer; an allocator setting may help and was not proven | owner (instance size) / later |
| A disk that stands still stands the server still | The save is a synchronous whole-file write. In the first pricing run after the container restarted, everything stopped for 19.9 s once; the kernel's own counter showed the disk had stalled for tens of seconds in that period (section 8). Not seen again in two later runs. Not something this work changed | later change of engine |
| Held mail and all the per-sender tallies are in memory | A restart forgets them (the allowances reset; held confirmation emails are lost and the customer has to ask again). One instance serves the site, as before | accepted for launch |
| `pending_payment` orders protect their files for 48 hours each | The expiry of unpaid orders is on the order-lifecycle branch. Until it is merged an unpaid order stays `pending_payment` for good; here it stops protecting after 48 hours and counts toward the holder's 50 MB | integration |
| An honest hollow part with a sealed cavity is sent to a person | By design (section 6, point 7). If the shop prints many of these, the answer is a "this is a void" choice on the quote, not a guess by the server | owner |
| Railway behaviours | Not measurable here: the platform's memory limit and what it does at the limit, what the edge does with a second request on a connection or with an answer sent while the body is arriving, per-thread CPU time from `/proc` (the reading limit falls back to the clock if it cannot be read) | first deploy |
| Node 20 | Only Node 22 is installed here. `socket.resetAndDestroy` (used for a second request on a refused connection) exists from Node 18.3; `worker.getHeapStatistics` from 22.16 only: on Node 20 the watchdog ranks parsers by the memory their thread has touched (page faults from `/proc`), which I could only exercise here by forcing that path on Node 22 (unit test, and `parse-pool.js steal` with the path forced: section 8) | first deploy |
| `server/routes/botCheck.test.js` reads the real data folder; the 250 ms assertion in `server/security/uploads.test.js` | Left alone as instructed | integration |

## 10. The commits of this round

On top of the merge of the re-review (`7c9de0f`), oldest first. The one titled "WIP" was made by the
coordinator when a session ran out; its contents were verified and finished in the commit after it.

- `964f99a` Pricing: one runner for the site, two lanes, a share of the thread for heavy quotes, seconds charged per address and account (RR-13, RR-05)
- `0d9c99d` Drafts and files: allowances per sender in bytes, checked on re-price too; the clean-up takes from the heaviest holder first, in pieces (RR-01, RR-02, RR-08, RR-11)
- `f4e17c0` Site-wide caps that cannot be turned against the next visitor; production needs the robot check (RR-03, RR-04)
- `f7013e6` Parsing: limits on CPU time, a lone parse has the whole share, nobody refused for memory without a clean run alone; shells inside shells and print-thin parts go to a person (RR-07, RR-09)
- `73d729c` WIP: work in progress saved when the session ran out of usage — not verified, do not merge
- `0905b94` Refused uploads: thrown-away bytes count, nothing else runs on that connection; the key check reads every file (RR-06, RR-12)
- `ed07595` Slow-file tests made with the test delay, not with a drawing that happens to be slow; new settings listed in .env.example
- `3f3587c` Pressure service header says what the passes do now; the save-time probe lifts the new per-sender allowances (dated comment)
- `92e33eb` Clean-up: sizes read from row headers; the back-off ends when a spared row stops being new; parsers ranked by memory touched where the runtime cannot be asked (Node 20); a sender far past its day's allowance gets a short reading-on
- `3540597` Parsing: the parse to stop is chosen by memory bands a few MB cannot tip; a lone parse stopped by the process line while small itself is asked to try again, not told it is too big; the STEP responsiveness test runs first, at the default lines
- `211d3f9` Clean-up: the rebuild and the write of a compaction are two pieces; a scenario script for customers arriving after memory-hungry uploads
- `c9d2a9c` Thin-print refusal says what is true of any part it refuses; the reorder retry caveat beside the exported gate
- `2f82141` Send it again: the day's attempt is charged as before, except when the site's own cap turned the email away with nothing in line
- `6238109` Round-2 write-up: findings, worst-case before and after, quota table, judgment calls, merge notes, every run, what is open
