# Availability and storage fixes, 2026-11-11

Branch `availability-fixes` (from `hardening-2026-11-11`, with `security-review-uploads-2026-11-11`
merged in). This answers the availability and storage findings of
`docs/security/independent-review-uploads-2026-11-11.md`. Every finding was reproduced with the
reviewer's own script before anything was changed, fixed as a class rather than at the one line the
script hit, and turned into a quick permanent test that fails on the old code.

Nothing here changes a price, a pricing rule, a gate threshold, a DFM threshold or a geometry result
for a legitimate file. The 300-quote vetting run is identical before and after (section 9).

Contents: 1 summary, 2 findings one by one, 3 every limit now in force, 4 retention table,
5 what happens when storage or the database is nearly full, 6 what to check in Railway,
7 merge notes for the other work in progress, 8 found beyond the review, 9 verification,
10 what remains open, 11 how to run the measurements again.

## 1. Summary

| Finding | Severity | State | Permanent test |
|---|---|---|---|
| C1 reopening a quote builds a 478 MB answer | Critical | Fixed | `server/routes/quoteSessionMesh.test.js` |
| C2 pricing blocks the whole site | Critical | Fixed for `POST /api/quote`; reorder is another lane's route, see 10 | `server/routes/pricingAvailability.test.js` |
| H1 `NaN` / `Infinity` / absurd sizes beat the price and the gate | High | Fixed | `server/parsers/saneGeometry.test.js` |
| H2 the parse pool is cheap to occupy | High | Fixed | `server/parsers/parseFairness.test.js`, `server/parsers/parsePool.test.js` |
| H3 draft quotes fill the database | High | Fixed; a many-address flood can still pause visitors without an account for minutes at a time, see 10 | `server/services/storagePressure.test.js`, `server/models/masterDatabase.test.js` |
| H4 the file ceiling can be filled | High | Fixed | `server/services/storagePressure.test.js`, `server/security/guards.test.js` |
| H5 files deleted while the quote can still be ordered | High | Fixed in retention and on the request form; the checkout check is a one-line call for another lane, see 7 | `server/services/storagePressure.test.js`, `server/services/rowRetention.test.js` |
| M1 verified-human token usable from anywhere, without limit | Medium | Fixed | `server/security/siteCaps.test.js` |
| M2 firm-quote requests from many addresses | Medium | Fixed | `server/security/siteCaps.test.js` |
| M3 email to addresses a stranger types | Medium | Fixed | `server/security/siteCaps.test.js` |
| M4 memory defaults larger than the container | Medium | Fixed in code; the Railway figure must be checked by the owner, see 6 | `server/parsers/parseFairness.test.js` |
| M5 what encryption does not cover | Medium | Document corrected; inline payloads moved into encrypted files; file names, measurements and DFM notes stay in the database in clear, see 10 | `server/models/partPayloads.test.js`, `server/services/fileEncryption.test.js` |
| L1 bytes that are not counted | Low | Fixed | `server/security/siteCaps.test.js` |
| L2 leftovers after a crash | Low | Fixed | `server/services/storagePressure.test.js` |
| L3 microscopic parts priced | Low | Fixed with H1 | `server/parsers/saneGeometry.test.js` |
| L4 the memory watchdog stops the wrong parse | Low | Fixed: likeliest culprit first, and the stopped parse gets one run alone | `server/parsers/parsePool.test.js` |
| L5 counters forgotten at a restart | Low | Accepted (reviewer: acceptable for one instance); C1, the way to force a restart, is closed | none |
| L6 a 4 kB DXF leaves a 50 kB row | Low | Fixed: 6 kB, and unquoted part rows are cleared under pressure | `server/services/storagePressure.test.js` |
| I1 file names read as Latin-1 | Info | Fixed | `server/security/siteCaps.test.js` |
| I2 `ip:port` is a new client per port | Info | Fixed | `server/security/siteCaps.test.js` |
| I3 the STEP "30 second" timer never fires | Info | Removed; the pool's per-kind limit is the real one | `server/parsers/parseFairness.test.js` |

## 2. The findings

All "before" numbers are from the reviewer's scripts run on this branch's starting point in this
sandbox; where the reviewer's report has a larger run, it is quoted as theirs. "Health" is the
response time of `GET /api/health` sampled every 50 ms while the attack runs: it is what every other
visitor experiences.

### C1. Reopening a quote can kill the server

**Root cause.** `GET /api/quote/:id/session` read the preview mesh of every line from its file and
put it inside one JSON answer, built on the one thread that serves everyone. One dense part on every
line multiplies: 100 lines of a 4.7 MB mesh is 478 MB of JSON, several times that in memory.

**Fix, as a class.** An answer may embed what is in a part's database row; anything that lives in a
file is named by URL and fetched separately.
- `server/services/quoteSession.js` builds the session answer from rows only. It opens no file.
  Parts are listed once (`partsById`), however many lines use them.
- `server/routes/partPayloadRoutes.js`: `GET /api/parts/:id/mesh` and `/geometry` stream the file
  (decrypting as a stream when encryption is on), with an ETag and a private one-hour cache, a size
  limit per file, a rate limit, and an hourly byte allowance per client.
- `server/security/meshAccess.js` is the single place that decides who may read a part's payload.
- `server/security/answerCeiling.js` is the backstop for every route: a JSON answer over 16 MB is
  not sent, the request gets a short refusal, and the log names the route. This is what stops the
  next route that grows without anyone noticing.
- The upload answer followed the same rule (it embedded up to ten meshes).
- Client: `client/src/utils/partLoader.js` fetches previews after the page is shown, one at a time,
  the part on screen first.

**Tests.** `quoteSessionMesh.test.js` (6): 100 lines of one dense part answer in kilobytes; the mesh
route streams, honours the edit key, caches, and refuses over its limits; the ceiling refuses an
oversized answer and names the route.

**Before and after** (`availability.js session 12 1`: one 2 MB STEP, mesh file 4.7 MB, 12 lines):

| | Before | After |
|---|---|---|
| Answer size | 57.3 MB | 0.1 MB |
| Time | 3.1 s | 7 ms |
| Server memory | 387 MB to 763 MB | 384 MB, unchanged |
| Health, worst / median | 1,911 ms / 1,292 ms | 12 ms / 2 ms |

Reviewer's 100-line run: 478 MB, over 2,670 MB of memory, process killed. The answer no longer
grows with the number of lines.

### C2. Pricing blocks the whole site

**Root cause.** Pricing is a pure, synchronous calculation that runs on the main thread, and it
re-read and re-analysed the same part once per line. A 148 kB DXF with 4,900 holes on 100 lines took
18 seconds, during which nothing else was served. Twenty such requests from one address were all
accepted.

**Fix, from outside the pricing function** (its inside belongs to another lane and is unchanged
apart from the one-line geometry check of H1):
- `server/services/pricingMemo.js`: for the length of one request, the data pricing asks for (the
  part, its DFM analysis, the engine's result for the same part and options) is remembered. The same
  part on 100 lines is read and analysed once. When a time slice (20 ms) is used up, the next thing
  not yet remembered interrupts the pass; the runner yields to the event loop and calls the pure
  function again, which now gets further. The last pass, with everything remembered, saves.
  Results are identical by construction: the same functions produce the same values, only once.
- A pricing budget (3 s of work, 20 s of wall clock): over it the request is refused with
  `quote-too-slow` and the offer of a firm quote.
- `server/security/pricingGate.js`: one pricing in flight per client (two may wait up to 4 s, the
  rest are told to retry in 3 s), at most 8 in flight site-wide, and 25 lines for a quote without an
  account (100 signed in, as before).

**Tests.** `pricingAvailability.test.js` (5): the dense quote prices to the same totals as the old
path line for line; the event loop is never held longer than a bound while it prices; a second
request from the same client waits or is told to retry; the budget refuses with the right code; the
anonymous line limit.

**Before and after** (4,900-hole DXF, 30 s of requests):

| | Before | After, no account (reviewer's script) | After, signed-in customer (`measure-pricing.js`) |
|---|---|---|---|
| 100-line quote | 18,099 ms median | refused: `too-many-lines` | 70 ms first, 357 ms median under load |
| Requests in 30 s | 20 sent, none refused | 359: 119 refused for line count, 240 rate-limited | 886: 114 priced, 772 told to retry in 3 s |
| Health, median / worst | 16,912 ms / 18,520 ms | 2 ms / 36 ms | 2 ms / 472 ms |

In-process, 1,600-hole DXF on 100 identical lines: 1,209 ms with one 1,197 ms stall before; 73 ms
with a worst stall of 37 ms after. The 472 ms worst case above is one unit that cannot be
interrupted (the first DFM analysis of a 4,900-hole part); see 10.

### H1. `NaN` and `Infinity` in a model beat the price and the gate

**Root cause.** Nothing checked that the numbers a parser produced were numbers. `NaN` compares
false with everything, so every "is it too big / too expensive" test passed, and a 400 mm block with
one stray `Infinity` corner priced at $339.16 with card checkout open.

**Fix, as a class.** Two layers, both in `server/parsers/**`:
- `inputGuards.js`, before parsing: a binary STL must be exactly as long as its triangle count says
  and every coordinate finite and in range; an ASCII STL's numbers must be numbers; STEP, IGES and
  3MF vertices are checked as they are read.
- `saneGeometry.js`, after parsing, whatever the format: `assertSaneGeometry(geometry)` requires a
  finite bounding box within ±100 m of the origin, no side over 10 m, a largest side of at least
  1 mm, every side at least 0.01 mm, a positive area and a real volume (not less than a millionth of
  the box). A DXF needs a positive width and height. This also closes L3 (a cube scaled by 10⁻³⁰).
- The same function is called where a part's geometry is loaded for pricing (one line, see 7), so a
  row written before these checks existed cannot price either.

Refusal codes: `geometry-not-measurable`, `geometry-out-of-range`, `geometry-too-small`,
`file-padded`, `file-damaged`. Each message says what to do and offers a quote by hand.

**Tests.** `saneGeometry.test.js` (9), including every hostile STL of the reviewer's table and the
check that all 300 vetting parts and every fixture still pass.

**Before and after** (`price-nan.js`, `parser-abuse.js`):

| Input | Before | After |
|---|---|---|
| 400 mm block, honest | $3,489.28 each, sent to a person | the same |
| + one triangle with a `NaN` corner | priced | refused at upload, `geometry-not-measurable` |
| + one triangle with an `Infinity` corner | $339.16 each, **card checkout open** | refused at upload |
| + its inside-out copy (volume cancels) | priced | refused at upload |
| ASCII STL, a coordinate written `e` or `1e999` | priced | refused at upload |
| cube scaled 10³⁰ / 10⁻³⁰ | priced ($191.62 with checkout open for the small one) | `geometry-out-of-range` / `geometry-too-small` |

### H2. The parse pool is cheap to occupy

**Root cause.** Two 950-byte DXFs could each run to the 60 s limit, a request of ten went on to the
next file after each timeout, and one address could take all eight waiting places. Two requests held
both workers for 605 seconds (reviewer's run). Two parser loops had no bound at all.

**Fix.**
- The two unbounded DXF loops are bounded (six added lines in `server/geometry/dxf/parse.js`, listed
  in 7): nested block arrays are capped at 20,000 copies in total, and an ellipse whose angles are
  not usable numbers is refused. Both now answer in milliseconds.
- Time limits by kind and size: DXF 10 s; STL / 3MF 15 s + 2 s per MB; STEP / IGES 30 s + 6 s per
  MB; never more than the overall 60 s. The STEP "30 second" timer that could not fire is gone (I3).
- Fairness in `parsePool.js`: one client may hold two of the eight waiting places; when a worker
  frees up, the client that has waited longest for a turn goes first; each client has 180 seconds of
  parsing per hour, charged for the time really used; a client whose parse was just stopped does not
  get the last free worker for an hour.
- A request stops at its first file that runs out of time: the rest are answered `not-read` ("upload
  this file by itself") instead of each taking its own minute.
- Size-proportionate input: a DXF over 20 MB, an ASCII STL far larger than its triangles need, and a
  text CAD file that is over 90 % blanks are refused before parsing.
- L4: when parsing as a whole is over its memory line, the parse stopped is the likeliest cause (a
  client already stopped this hour, then the largest file, then the longest-running), and if others
  were running too it is run once more by itself before anyone is refused.

**Tests.** `parseFairness.test.js` (7), `parsePool.test.js` (14, two of them new or rewritten for
L4).

**Before and after** (`availability.js queue`, `pool`):

| | Before | After |
|---|---|---|
| Two requests of ten hostile DXFs hold the workers | 605 s (reviewer) | 1 s: all 20 files refused, `dxf-too-many-blocks` |
| Twelve hostile uploads from one address, then three customers with a 2 MB STEP | customer 1 served in 16.4 s; customers 2 and 3 refused, `busy` | all three served (15 s, 25 s, 35 s on this loaded sandbox) |
| Hostile DXFs (nested blocks, ellipse 1e308) | stopped at 60 s each | refused in under 0.1 s |

### H3. Draft quotes fill the database

**Root cause.** Every priced quote was a new row holding every priced line in full (298 kB for 100
lines), a client could choose the row's id, nothing limited new rows, and the database ceiling
refused uploads (the customers) while quotes (the flood) went on. A restart did not help.

**Fix.**
- The server makes every quote id; an id from the client that it did not issue never becomes a row.
- New draft rows are limited per client (30 an hour, 120 a day) and per account (60 / 240).
  Re-pricing a quote that is open is not a new row and is not limited.
- Lines are stored once per distinct line (`server/models/quotesStore.js`); they read back exactly.
  Re-pricing writes are batched.
- A draft of a visitor without an account that is never opened again lapses 48 hours after it was
  last priced (it was 30 days). A customer's quote, and any quote reopened, keeps the full hold.
- The ceiling degrades the right way round (section 5): at 80 % old drafts and unquoted parts are
  removed and the file is compacted; from 85 % visitors without an account are asked to sign in;
  customers with a confirmed email use the last 15 %; checkout, sign-in, orders and payment
  notifications are never checked against the ceiling.
- The default ceiling follows the memory budget (64 MB for a 1 GB container, section 6).
- Admin: "Clear old drafts" on the quotes tab.
- L6: geometry detail over 8 kB goes to the part's file (it was 64 kB), so a small DXF leaves a 6 kB
  row instead of 50 kB, and part rows that nothing refers to are cleared by the same pressure pass.

**Tests.** `storagePressure.test.js`: a client cannot choose an id; row limits; compaction reads back
exactly; the admin list is a list; "database nearly full" proves in a 4 MB database that the flood
stops under the ceiling, that customers, re-pricing, sign-in and checkout go on, and that it
recovers by itself; the admin purge; L6. `masterDatabase.test.js` (3) opens a database written by
`origin/master`'s own code and proves the additive migration.

**Before and after** (`availability.js db`, ceiling set to 16 MB for the run):

| | Before | After |
|---|---|---|
| Bytes per quote | 297,796 (100 lines) | 9,065 (25 lines, of which 2,000 are the script's note text) |
| Quotes to trouble | 75 (21.3 MB, over the ceiling) | 1,574 from 53 addresses to reach 85 % (13.6 MB); it never passes the ceiling |
| Who is refused then | every upload, customers included; still refused after a restart | new quotes and uploads from visitors without an account (`quotes-paused`, `uploads-paused`); re-pricing an open quote: 200 |
| Recovery | none without the owner | by itself: drafts and parts untouched for 5 minutes are removed |
| Health during the flood, worst | not measured (server refused) | 258 ms |

L6 (`claims.js`): 100 DXFs of 4.4 kB added 50 kB each to the database before, 6.0 kB each after.

### H4. The file ceiling

**Root cause.** A 49 MB file that was one cube and 49 MB of blanks was accepted, bytes were limited
per day but not in total, nothing gave space back before the ceiling, and a closed request kept its
attachment for ever.

**Fix.** Padded files are refused before parsing (H2's input guards). Bytes stored per client are
capped (400 MB) as well as bytes sent per day. At 80 % the pressure pass removes, in this order,
uploads no part refers to, the oldest uploads nothing refers to, then uploads only an idle,
never-reopened no-account draft refers to. From 85 % visitors without an account are asked to sign
in or email the files; the last 15 % is for customers with a confirmed email. Attachments of
requests that are declined, lost or expired are deleted 14 days after closing. Admin: "Delete
request" removes a request and its attachment.

**Tests.** `storagePressure.test.js` ("files nearly full", "bytes stored per client", "requests"),
`guards.test.js`.

**Before and after** (`availability.js storage`, ceiling 200 MB):

| | Before | After |
|---|---|---|
| Six 49 MB padded files | four stored (196 MB), then everyone refused | all refused, `file-padded`, in 0.4 s; 0 MB stored |
| A customer's upload afterwards | refused until a restart and a sweep | accepted |

### H5. Files deleted while the quote can still be ordered

**Root cause.** The file sweep kept only files on orders and open requests. A quote is good for 30
days; its CAD file went at 7. An order on day 8 succeeded and the shop had nothing to make it from.

**Fix.** One definition of what is live (`rowRetention.references()`), used by every sweep: a file
stays while a quote that can still be ordered, an order, or an open request refers to it.
`fileRetention.partFilesPresent(partIds)` answers "are the files of these parts still here"; the
request form calls it and asks for the file again (`part-file-missing`) instead of taking a request
the shop cannot quote. The same one-line call belongs in checkout (another lane, see 7).

**Tests.** `storagePressure.test.js` ("a file on a saved quote that can still be ordered is never
swept"), `rowRetention.test.js`.

**Before and after** (`retention-encryption.js retention`):

| Check | Before | After |
|---|---|---|
| Order on day 8 of a 30-day quote still has its file | checkout 200, file gone | file present |
| Request on day 8 from a quote still has its file | request 201, file gone | file present |
| Drawing of a request declined 400 days ago | kept | removed (counted from the day it was closed) |
| Upload left by a process killed mid-parse | kept 7 days | removed at the next start |

### M1. The verified-human token

It worked from any address and without limit. It is now bound to the client that passed the check
and has a use ceiling (2,000 in its hour), and reopening a quote or fetching a preview needs it too.
`abuse-limits.js on`: a token used from another address, 200 before, 403 now.

### M2. Firm-quote requests

Ten an hour per address added up across addresses. Requests from senders who cannot be verified now
share one allowance for the whole site (30 an hour); past it the form answers `requests-paused`
before the attachment is read. A signed-in customer, or anyone who passed the bot check, is not
counted and not refused. `abuse-limits.js off`: 10 + 2 + 10 + 8 = 30 accepted from four addresses,
then refused (all 32 accepted before).

### M3. Email to addresses a stranger types

`server/services/mailCaps.js`: site-wide hourly caps on mail to unconfirmed addresses (60) and on
new-request notices to the shop's inbox (40). The owner gets one notice when a cap is reached. Order,
payment, password and security mail is never capped. Requests are still stored and shown in the
admin panel when their email is held. `mailer.capCounters()` reports the counts.

### M4. Memory

One setting, `MEMORY_BUDGET_MB` (default 1024), sizes the parse workers' heap (3/8 of it each), the
memory all parsing together may add (half), and the database ceiling (a sixteenth, 64 to 256 MB).
The old defaults (768 MB per worker, 1,024 MB for parsing) were larger than a 1 GB container. See 6.

### M5. What encryption does not cover

`docs/security/file-encryption.md` now says exactly what is and is not encrypted. With a key set,
preview meshes and geometry detail that used to sit in the database row are written to encrypted
files, and existing rows are moved at start-up. A start-up check prints
`ERROR: EXISTING FILES CANNOT BE OPENED` when the key does not open what is on disk. Still in the
database in clear: file names, overall measurements, DFM notes (with feature positions) and quote
lines. See 10.

### L1, L2, I1, I2

- L1: bytes are counted where they arrive, on every outcome. A body sent without a length is
  counted as it comes and cut off at the limit; what a request declares is reserved at the door, so
  parallel uploads cannot all be admitted against the same remaining budget. `availability.js
  budget`: six 8 MB chunked attachments on a 20 MB budget, all six stored (64 MB) before; two
  stored, four refused now. `refused`: 204 MB of over-size files went uncharged before; each is now
  cut off at the budget.
- L2: uploads with no part row are swept at start-up and hourly once 15 minutes old.
- I1: file names are read as UTF-8. I2: an address with a port is one client.

## 3. Every limit now in force

All are settings in `server/security/limits.js`, listed in `.env.example`. "Key" is what the limit
is counted against. Customer wording is as shown on the page (contact details come from
`shared/brand.json`).

| What | Default | Key | Setting | What the customer reads (code) |
|---|---|---|---|---|
| Lines in a quote without an account | 25 | request | `QUOTE_MAX_LINES_ANON` | "An instant quote without an account holds up to 25 lines. Sign in to price more at once, or send us the files for a firm quote and we'll price the whole job by hand." (`too-many-lines`) |
| Pricing requests in flight | 1 running, 2 waiting up to 4 s | client | `QUOTE_PRICE_WAIT_MS` | "We're pricing a lot of quotes right now. Try again in a few seconds, or call ..." (`pricing-in-progress`; the page retries by itself) |
| Pricing in flight, whole site | 8 | site | `QUOTE_PRICE_MAX_INFLIGHT` | the same (`pricing-busy`) |
| Work to price one quote | 3 s of work, 20 s elapsed, 20 ms at a time | request | `QUOTE_PRICE_BUDGET_MS`, `QUOTE_PRICE_WALL_MS`, `QUOTE_PRICE_SLICE_MS` | "This quote is taking longer to price than the instant quote allows. Send us the files for a firm quote and we'll price it by hand, or split it into smaller quotes." (`quote-too-slow`) |
| New draft quotes | 30 an hour, 120 a day | client | `QUOTE_NEW_PER_CLIENT_HOUR`, `QUOTE_NEW_PER_CLIENT_DAY` | "You've started a lot of new quotes in a short time. Keep working on a quote you already have open, or try again later. For a big job, email the files ... and we'll quote it by hand." (`quote-limit`) |
| New draft quotes, signed in | 60 an hour, 240 a day | account | `QUOTE_NEW_PER_ACCOUNT_HOUR`, `QUOTE_NEW_PER_ACCOUNT_DAY` | the same |
| Database ceiling | 64 MB at the default memory budget | site | `DB_MAX_MB` | see section 5 (`quotes-paused`, `uploads-paused`, `storage-full`) |
| Database: clean-up line / share kept for customers | 80 % / 15 % | site | `DB_SWEEP_PERCENT`, `DB_RESERVED_PERCENT` | none |
| Draft or unquoted part left alone by the clean-up | 30 min untouched; 5 min once visitors are being refused | row | `DRAFT_SWEEP_MIN_AGE_MINUTES`, `DRAFT_SWEEP_URGENT_MIN_AGE_MINUTES` | none |
| No-account draft never reopened | lapses after 48 h | quote | `QUOTE_ANON_DRAFT_HOURS` | reopening it later: the quote is not found, upload again |
| File ceiling (existing) | 2,048 MB | site | `UPLOAD_DIR_MAX_MB` | "We can't take new files right now. Email them to ... or call ... and we'll quote them by hand." (`storage-full`) |
| Files: clean-up line / share kept for customers | 80 % / 15 % | site | `UPLOAD_DIR_WARN_PERCENT`, `UPLOAD_DIR_RESERVED_PERCENT` | "We can't take new files from visitors without an account right now. Sign in (or create an account and confirm your email) and upload again, or email the files ..." (`uploads-paused`) |
| Upload left alone by the clean-up | 30 min | file | `STORAGE_EVICT_MIN_AGE_MINUTES` | none |
| Bytes sent per day (existing, now counted on every outcome) | 500 MB | client | `UPLOAD_DAILY_MB_PER_IP` | "You've reached today's upload limit from this network (500 MB in 24 hours). Email your files ... and we'll quote them by hand." (`daily-upload-limit`) |
| Bytes stored at one time | 400 MB | client | `UPLOAD_STORED_MB_PER_IP` | "You've reached what we keep for one network at a time (400 MB of files). Files that are not on an order or a saved quote are cleared after a few days. Email your files ..." (`stored-limit`) |
| One upload request (existing) | the route's maximum | request | existing | "That upload is too large. Send up to N MB at a time." (`request-too-large`) |
| Waiting places for parsing | 2 of 8 | client | `PARSE_QUEUE_PER_CLIENT` | "We're reading a lot of files right now. Give it a minute and upload this one again." (`busy`) |
| Parsing time | 180 s an hour | client | `PARSE_SECONDS_PER_CLIENT_HOUR` | "We've spent as long reading files from this network in the last hour as the instant quote allows. Try again later, or email your files ... and we'll quote them by hand." (`parse-budget`) |
| Time to read one file | DXF 10 s; STL / 3MF 15 s + 2 s per MB; STEP / IGES 30 s + 10 s per MB; at most 60 s | file | `PARSE_TIMEOUT_DXF_MS`, `PARSE_TIMEOUT_MESH_BASE_MS`, `PARSE_TIMEOUT_MESH_PER_MB_MS`, `PARSE_TIMEOUT_CAD_BASE_MS`, `PARSE_TIMEOUT_CAD_PER_MB_MS` | "This model took more than N seconds to read, which is longer than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us for a firm quote." (`parse-timeout`) |
| Rest of a request after a file ran out of time | not read | request | none | "We stopped reading this upload because another file in it could not be read in time. Upload this file by itself and it will be read." (`not-read`) |
| No last free worker after a stopped parse | 60 min | client | `PARSE_SUSPECT_MINUTES` | waits in line; at worst `busy` |
| Memory for parsing | worker heap 384 MB, all parsing 512 MB at the default budget | site | `MEMORY_BUDGET_MB`, or `PARSE_MAX_HEAP_MB`, `PARSE_RSS_LIMIT_MB` | "This model needs more memory to read than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us for a firm quote." (`parse-memory`) |
| DXF file size | 20 MB | file | `DXF_MAX_FILE_MB` | "This DXF is over 20 MB, more than a part outline needs. Export just the part's outline and holes and upload again, or send it to us for a firm quote." (`model-too-large`) |
| DXF block copies | 20,000 | file | `DXF_MAX_BLOCK_INSTANCES` | "This DXF repeats its blocks more times than the instant quote reads. Explode the blocks and export the outline again, or send it to us for a firm quote." (`dxf-too-many-blocks`) |
| DXF ellipse angles | must be usable numbers | file | none | "This DXF has an ellipse whose start or end angle is not a usable number. Re-export the outline from your CAD program, or send it to us for a firm quote." (`dxf-bad-ellipse`) |
| File much larger than its model | ASCII STL over 1,000 bytes per facet; text CAD over 90 % blanks; binary STL not its stated length | file | `STL_ASCII_MAX_BYTES_PER_FACET`, `CAD_MAX_BLANK_PERCENT` | "This file is much larger than the model inside it needs, which usually means the export went wrong. Re-export it from your CAD program and upload again, or email it ... and we'll quote it by hand." (`file-padded`); a broken facet: "This file is damaged or incomplete. Re-export it from your CAD program and upload again." (`file-damaged`) |
| Model coordinates and size | within ±100 m; no side over 10 m | part | `GEOMETRY_MAX_COORD_MM`, `GEOMETRY_MAX_EXTENT_MM` | "This model's size doesn't come out as a real part: it is far larger than anything we make, or sits very far from the origin. Check the export units and upload again, or send it to us and we'll quote it by hand." (`geometry-out-of-range`) |
| Model smallest size | largest side 1 mm, every side 0.01 mm | part | `GEOMETRY_MIN_PART_UM`, `GEOMETRY_MIN_THICKNESS_UM` | "This model comes out smaller than anything we can hold or measure. Check the export units (millimetres or inches) and upload again, or send it to us and we'll quote it by hand." (`geometry-too-small`) |
| Model measurements must be numbers | finite, positive area, real volume | part | none | "We couldn't measure this model: some of its coordinates are not real numbers, or it has no solid volume. Re-export it from your CAD program as a solid and upload again, or send it to us and we'll quote it by hand." (`geometry-not-measurable`) |
| Any JSON answer | 16 MB | answer | `JSON_ANSWER_MAX_MB` | "That is more than we can show in one page. Reload the page; if it happens again, email ... or call ... and we'll sort it out by hand." (`answer-too-large`) |
| One preview file | 24 MB | file | `PART_PAYLOAD_SERVE_MAX_MB` | "We can't show the preview of this part right now. The quote and its price are not affected." (`preview-too-large`) |
| Preview bytes | 600 MB an hour | client | `PART_PREVIEW_MB_PER_CLIENT_HOUR` | "You've loaded a lot of previews from this network in the last hour. They'll be back shortly; pricing and ordering still work." (`preview-limit`) |
| Preview requests | 240 per 15 min | client | `RATE_PART_PREVIEW_PER_15MIN` | "You've loaded a lot of part previews in a short time. They'll be back in a few minutes; pricing and ordering still work." (`preview-rate-limited`) |
| Geometry detail kept in the database row | 8 kB (was 64) | part | `PART_INLINE_GEOMETRY_KB` | none |
| Verified-human token | the client that passed the check; 2,000 uses in its hour | client | `HUMAN_TOKEN_MAX_USES` | the one-time check is shown again (`human-check-required`) |
| Requests from senders who cannot be verified | 30 an hour | site | `RFQ_UNVERIFIED_PER_HOUR_SITE` | "We're getting more requests than we can read right now, so the form is paused for a little while." with the phone number (`requests-paused`) |
| Mail to unconfirmed addresses | 60 an hour | site | `MAIL_UNCONFIRMED_PER_HOUR_SITE` | nothing refused: the account or request is taken, the email is held; the owner gets one notice |
| New-request notices to the shop | 40 an hour | site | `MAIL_SHOP_REQUESTS_PER_HOUR_SITE` | nothing refused: requests are stored and shown in the admin panel; the owner gets one notice |
| Request form when a quoted file is gone | none | quote | none | "We no longer have (file name) on our server. Please upload the file again and we'll pick up where you left off." (`part-file-missing`) |
| Attachment of a closed request | deleted after 14 days | request | `RFQ_CLOSED_ATTACHMENT_DAYS` | none |
| Upload with no part row | deleted after 15 min | file | `UPLOAD_ORPHAN_MINUTES` | none |

A refused upload is now answered so that a browser still sending the file reads the message rather
than a dropped connection (`uploadGuards.lingerThenClose`: what is still arriving is discarded for at
most 5 seconds and 64 MB, then the connection is closed).

## 4. Retention

| What | Kept while | Removed |
|---|---|---|
| Uploaded CAD file and its part row | an order that was not cancelled, an open request, a customer's quote inside its 30-day hold, or a no-account draft that is still live refers to it | 7 days after upload (`UPLOAD_RETENTION_HOURS`) once nothing refers to it; sooner under pressure (section 5) |
| Preview mesh and geometry-detail files | their part row exists | with the part row |
| Draft quote, signed-in customer | inside its price hold (30 days) | when the hold runs out |
| Draft quote, no account, reopened at least once | inside its price hold | when the hold runs out |
| Draft quote, no account, never reopened | 48 hours after it was last priced | then; sooner under pressure, longest-untouched first |
| Quote that became an order or a request | always | never by a sweep |
| Request attachment, request open (new, in review, quoted and still valid, accepted, won) | always | never by a sweep; the admin can delete the request |
| Request attachment, request declined, lost or expired | 14 days from the day it was closed | then (the request row stays, marked "attachment removed") |
| Drawing no quote, order or request refers to | 24 hours | then |
| Upload with no part row (interrupted upload) | 15 minutes | at the next start or hourly sweep |
| Order, its parts and files | always | never |

## 5. When storage or the database is nearly full

The order is the same for both: clear what nobody needs, then ask visitors without an account to
sign in, and only at the very end refuse customers. Buying is never blocked.

**Database** (`DB_MAX_MB`):
1. Under 80 %: nothing happens.
2. At 80 %: the pressure pass runs (every 5 minutes, and at once when a request is refused, at most
   every 20 seconds). It removes lapsed drafts; uploaded parts that nothing refers to and nobody has
   touched for 30 minutes, the network that left the most first; then no-account drafts untouched
   for 30 minutes, longest-untouched first; down to 60 %. Then it compacts the file.
3. At 85 %: a visitor without an account cannot start a new quote (`quotes-paused`) or upload
   (`uploads-paused`); both messages say to sign in or email the files. The "untouched" wait drops to
   5 minutes. Re-pricing a quote that is already open still works. Customers with a confirmed email
   carry on.
4. At 100 %: new quotes and uploads are refused for everyone (`storage-full`, with the email address
   and phone number).
5. Never checked against the ceiling: sign-in, password reset, checkout, order pages, payment
   notifications from Stripe, the admin panel.

**Files** (`UPLOAD_DIR_MAX_MB`):
1. At 80 %: the pressure pass removes uploads no part row names; then the oldest uploads nothing
   refers to (30 minutes old at least); then uploads that only an idle, never-reopened no-account
   draft refers to, with that draft; down to 65 %.
2. At 85 %: uploads and attachments from visitors without an account are refused (`uploads-paused`).
3. At 100 %: refused for everyone (`storage-full`).
4. Never removed by any of this: a file on an order, on an open request, or on a customer's saved
   quote.

`GET /api/admin/storage` (admin only) and `storagePressure.status()` report where both stand and
what the last pass removed.

## 6. What the owner must check in Railway

One figure matters: the memory the service is allowed.

1. Railway, the service, Settings, Resources: read the memory limit.
2. Variables: set `MEMORY_BUDGET_MB` to that figure in MB. Without it the server assumes 1024.

| Service memory | `MEMORY_BUDGET_MB` | Parse worker heap | All parsing | Database ceiling |
|---|---|---|---|---|
| 1 GB (the default assumed) | 1024 | 384 MB | 512 MB | 64 MB |
| 2 GB | 2048 | 768 MB | 1,024 MB | 128 MB |
| 4 GB | 4096 | 1,536 MB | 2,048 MB | 256 MB |

3. The start-up log prints the line to compare against:
   `Memory budget: 1024 MB (MEMORY_BUDGET_MB) — parse workers 384 MB heap each, 512 MB for parsing in all; database ceiling 64 MB.`
4. In the Metrics tab, memory should sit well under the limit when idle (about 150 to 400 MB here)
   and return there after uploads. If it climbs to the limit and the service restarts, lower
   `MEMORY_BUDGET_MB` or raise the plan.
5. Keep the restart policy at "on failure" so a crash restarts the service.
6. At 1 GB some large STEP files that parsed before are now answered `parse-memory` and offered a
   firm quote. That is the honest capacity of a 1 GB container; the old settings would have let the
   container be killed instead, which takes the site down for everyone. Raising the plan to 2 GB
   and setting 2048 restores the old headroom.
7. If `DB_MAX_MB`, `PARSE_MAX_HEAP_MB` or `PARSE_RSS_LIMIT_MB` are already set as variables they
   win over the derived values. Remove them unless they were set on purpose.

Not checkable from here, to confirm on the first deploy: that Railway's edge passes the visitor's
address as the last entry of `X-Forwarded-For` (every per-client limit depends on it), how it
forwards a body sent without a length, and Node 20 itself (this sandbox has Node 22 only; the code
uses nothing newer than Node 20 offers).

## 7. Merge notes

**Lines added in other lanes' files.**

`server/geometry/dxf/parse.js` (geometry-speed), six lines, no existing line changed:
- after `const maxEntities = ...` (new line 28):
  `const maxBlockInstances = () => require("../../security/limits").limits.dxfMaxBlockInstances;`
- before `const walk = (recs, m, depth, insertLayer) => {` in `normalise` (new line 366):
  `let blockInstances = 0;`
- in the ELLIPSE branch, after `let sweep = t1 - t0;` (new lines 439 and 440): a comment and
  `if (!Number.isFinite(sweep) || Math.abs(t0) > 1e6 || Math.abs(t1) > 1e6) throw Object.assign(new Error("This DXF has an ellipse whose start or end angle is not a usable number. ..."), { code: "dxf-bad-ellipse", offerRfq: true });`
- in the INSERT branch, after the `cols * rows > 10000` line (new lines 493 and 494): a comment and
  `if ((blockInstances += cols * rows) > maxBlockInstances()) throw Object.assign(new Error("This DXF repeats its blocks more times than the instant quote reads. ..."), { code: "dxf-too-many-blocks", offerRfq: true });`

`server/routes/api.js`, inside `priceQuote` (review-fixes), one line right after the existing
`payloadError` check (line 567), plus the import at line 17:
`assertSaneGeometry(part.geometry, { partId: config.partId, fileName: part.fileName });`
It throws an error carrying `status: 422`, `code`, `offerRfq` and `expose: true`. Keep it wherever
part geometry is loaded for pricing after that function is reworked.

**Calls other lanes should add.**

- Checkout (review-fixes, `orders.js`), before the order is written:
  ```js
  const files = require("../services/fileRetention").partFilesPresent((quote.lineItems || []).map((li) => li.partId));
  if (!files.ok) return res.status(409).json({ error: files.message, code: files.code });
  ```
  Retention now keeps these files, so this should never fire; it is the check that an order is never
  taken for a part the shop cannot make.
- Reorder (`POST /api/orders/:id/reorder`) still prices on the main thread without the memo or the
  gate. Wrap it the way `POST /api/quote` is wrapped: `pricingGate.admit()` as middleware and
  `await pricingMemo.run(() => ...)` around the pricing call.
- Shutdown (deploy-runbook): call `require("./models/database").flush()` before exit. Re-pricing
  writes are batched for up to 1.5 s; `database.js` already flushes on SIGTERM and SIGINT, and exits
  itself only when it is the only listener.
- Status page (deploy-runbook) can read: `storagePressure.status()`, `mailer.capCounters()`,
  `botGuard.unverifiedRequestStats()`, `pricingGate.stats()`, `quoteGuards.stats()`,
  `parsePool.pool.stats()` (new counters `overBudget`, `queueFullForClient`, `rerunAlone`),
  `answerCeiling.counters`, and `GET /api/admin/storage`.

**The mesh-access helper.** `server/security/meshAccess.js` exports `mayReadPart(req, part)` and
`partKeyFrom(req)`. It is the only place the preview routes ask "may this request read this part".
When review-fixes' `server/security/partAccess.js` lands, its body becomes
`return require("./partAccess").canUse(part, { user: req.user, key: partKeyFrom(req) });`
and nothing else changes.

**Answer contracts that changed** (client updated in this branch; anything else reading them must
follow):
- `GET /api/quote/:id/session` returns `parts` (line configuration) and `partsById` (one entry per
  part: `fileName`, `dfm`, `geometry`, `meshPreview` with `positions` only when the mesh is small
  enough to live in the row, else `mesh: { url, triangleCount, bytes }`, and `geometryDetail:
  { url, bytes }` when the detail is in a file). It needs the verified-human token when the bot
  check is on.
- `POST /api/upload` parts carry `mesh.url` / `geometryDetail.url` in the same way.
- `POST /api/quote` ignores a `quoteId` the server did not issue and answers with its own.
- `GET /api/admin/quotes` is a list of summaries (`X-Total-Count` header), not every line.
- An upload with a file that is one flat sheet of triangles is refused (no volume). Tests that need
  an accepted STL use `solidStl()` from `server/testSupport/zip.js`.

**Shared test support.** `server/testSupport/harness.js`: the suite's standard human token is
re-issued for the address each call comes from (tokens are bound to the client now).
`scripts/e2e/hardening-accounts.mjs`: a guest asking for someone else's quote session may get 403
(no bot check passed) or 404. `tools/security/csp-browser-check.js`: the reopened-quote step reads
the preview from its own route, and a new step checks a three-part quote reopened.

**Reviewer's scripts** stay runnable. Three were adapted, each with a dated comment in the file:
`availability.js db` goes on with 25 lines when 100 are refused and reports what a visitor meets
when new quotes pause; `retention-encryption.js` ages the request's row as well as its file, and
checks the orphan file by name; `abuse-limits.js` passes the bot check once per address.

**Schema.** Additive only, in `server/models/database.js` with the field maps in `SqliteDB.js`:
`quotes.last_opened_at`, `quotes.part_count`, `quotes.total_units`, `parts.client_tag`,
`rfqs.client_tag`, `rfqs.drawing_bytes`, `rfqs.attachment_removed_at`. Proven on a database created
by `origin/master` code (`server/models/masterDatabase.test.js`, fixture under
`server/security/fixtures/`).

**Wording for journey-qa.** `client/src/pages/LandingPage.jsx:44` says files are "deleted after 7
days unless you order". Files on a saved quote are now kept for the quote's 30 days. The sentence
should be corrected by the lane that owns the page.

## 8. Found beyond the review

| What | Severity | State |
|---|---|---|
| `GET /api/admin/quotes` returned every line of every quote: the admin panel would have built the same giant answer as C1 once quotes accumulated | High | Fixed (summaries, capped) |
| The upload answer embedded up to ten preview meshes | Medium | Fixed (URL per part) |
| Parallel uploads could all be admitted against one remaining daily budget | Medium | Fixed (declared bytes reserved at the door) |
| The default database ceiling was not safe for a 1 GB container (the file is held in memory and copied on every save) | Medium | Fixed (derived from the memory budget) |
| Part rows fill the database as well as quotes, and the clean-up only removed quotes | Medium | Fixed (unquoted parts are cleared under pressure) |
| A refused upload often reached the browser as a dropped connection, not as the message (about one time in four in the reviewer's own runs) | Low | Fixed (`lingerThenClose`) |
| An upload cut off mid-body crashed the process when the upload handler answered a second time | High, introduced and caught while fixing L1 | Fixed, with a test |
| Two concurrent mid-size STEP files could cross the parsing memory line and one customer was refused | Medium at 1 GB | Fixed (the stopped parse is run again alone) |
| With a new encryption key and M5's wider coverage, every existing part becomes unreadable until the previous key is listed | Operational | Start-up check prints `EXISTING FILES CANNOT BE OPENED`; documented in `file-encryption.md` |

## 9. Verification

All runs are on this branch's head, in the shared sandbox (Node 22, other work running beside it).

| Check | Result |
|---|---|
| `npm test` | 48 suites, 459 tests. 48/48 passed on the run made while the sandbox was quiet. On the two runs made while other work was loading the machine (load average 7 to 9), 47/48: one timing check in `uploads.test.js` failed, see below |
| `NODE_ENV=production npm run build` | 22/22 routes rendered |
| `node scripts/claims-check.js` | exit 0 |
| `tools/vet-quotes/run_vetting.js` | 300 quotes, 0 fails, 63 warnings; against the run made before any change, 0 of 300 rows of `results.csv` differ once the quote-id column is blanked. Run again after the last change to pricing-adjacent code (the 8 kB row limit) |
| `scripts/e2e/hardening-accounts.mjs` (Chromium) | 96/96 checks |
| `tools/security/csp-browser-check.js` (Chromium) | 67 steps, 67 clean, 0 policy violations, 0 page errors, 0 failed requests; policy proof passed |
| Reopened multi-part quote, in the browser (step 39 of the check above) | Three parts (an STL, a STEP, a small cube). The session answer is 18 kB. Two previews are named by URL and fetched one after the other, the part on screen first, none overlapping, none twice; the cube's preview is small enough to travel with its row. Each part's 3D view was screenshotted and looked at: the star wheel, the plate with its holes, and the cube are each drawn |
| Additive migration | `masterDatabase.test.js`: a database written by `origin/master`'s own server opens, gains the new columns, and its quotes, parts and orders read back |

Reviewer's scripts, each run before and after (numbers in section 2):

| Script | Before | After |
|---|---|---|
| `availability.js session 12 1` | 57.3 MB answer, health worst 1,911 ms | 0.1 MB, 12 ms |
| `availability.js mainthread` | health median 16,912 ms | 2 ms; the quote is refused for line count or rate |
| `measure-pricing.js 4900 30` (signed in) | not possible to measure: 18 s per quote | health median 2 ms, worst 472 ms; 114 priced, 772 told to retry |
| `price-nan.js` | `Infinity` variant priced with checkout open | every variant refused at upload |
| `parser-abuse.js` (the 16 inputs in this lane) | 11 accepted that should not be, 2 stopped only at 60 s, 2 refused, 1 parsed and sent to a person | the 11 and the 2 refused in under 1 s; the other 3 as before |
| `availability.js queue` | 2 of 3 customers refused | 3 of 3 served |
| `availability.js pool` | workers held 605 s (reviewer) | 1 s |
| `availability.js db` | 75 quotes over the ceiling, customers refused, no recovery | 1,574 quotes to reach 85 %; only visitors without an account paused; recovers by itself |
| `availability.js storage` | 196 MB of padding stored, then everyone refused | 0 MB stored, customers served |
| `retention-encryption.js retention` | 4 findings | 0 findings, 5 passes |
| `abuse-limits.js on` / `off` | token usable anywhere; 300 drafts per 15 min; 32 of 32 requests | 403 elsewhere; 30 drafts then refused; 30 requests an hour site-wide |
| `availability.js budget` / `refused` | 64 MB stored on a 20 MB budget; 204 MB uncharged | 16 MB stored; every refused byte counted; every refusal read by the sender |
| `availability.js keys` | `ip:port` a new client per port | one client |
| `claims.js` | 50 kB a DXF row | 6.0 kB |

Could not be verified here, and why:
- Railway itself: the memory limit of the service, what its edge does with `X-Forwarded-For`, with a
  body sent without a length, and with an answer that arrives while the body is still being sent.
  There is no access to the deployment from this sandbox.
- Node 20: only Node 22 is installed here.
- Cloudflare's own Turnstile script: the sandbox cannot fetch it, so the browser suites use the
  repository's stand-in for it, as before.
- One existing test depends on how busy the machine is: `uploads.test.js` "event loop stays
  responsive while a large STEP file parses" allows 250 ms for any health check during the parse.
  With the sandbox loaded, its first check (sent at the moment the 2 MB upload starts arriving) took
  320 to 410 ms; with the sandbox quiet the worst check was 32 to 75 ms and the test passed. Measured
  side by side under the same load with the same script, the server's stall at that moment is 130
  to 183 ms on this branch and 241 to 276 ms on the branch it started from, and the stall when the
  parsed part is stored is 274 to 356 ms here against 392 to 597 ms there (the answer no longer
  carries the mesh). The threshold was not changed; the assertion now says which check was slow.

## 10. What remains open

| Item | Severity | Whose | Note |
|---|---|---|---|
| Reorder prices on the main thread without the memo or the gate | Medium | review-fixes / order-lifecycle | Signed-in customers only; the call to add is in 7 |
| Checkout does not call `partFilesPresent` | Low now that retention keeps the files | review-fixes | One-line call in 7 |
| A flood from many addresses with the bot check off can still pause new quotes and uploads for visitors without an account | Medium | owner | It takes a few hundred addresses, each at its hourly limit, to hold the default database at 85 %. Customers with a confirmed email, re-pricing and checkout are unaffected, and it clears itself 5 minutes after the flood stops. The real answer is switching the bot check on (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`) |
| File names, overall measurements, DFM notes with feature positions and quote lines are in the database in clear | Medium | owner decision | Encrypting the database file is a separate piece of work; the guide now says so plainly |
| The whole database file is rewritten on every save | Medium (speed, not safety) | future work | 258 ms worst health at 13 MB during a flood. A native SQLite driver removes it |
| One uninterruptible unit of pricing: the first DFM analysis of a very dense part (4,900 holes) holds the thread for about half a second | Low | geometry-speed | Yielding inside the analysis is inside another lane |
| Storing a parsed dense part (the DFM analysis and writing its preview) holds the thread for 0.1 to 0.3 s per upload | Low | geometry-speed | Halved by this branch (the answer no longer carries the mesh); moving the rest into the worker is that lane's |
| The 3D view frames a small cube very close on a reopened quote | Low (looks) | journey-qa | Seen in the browser check; the viewer's framing code is unchanged by this branch |
| IPv6: per-client limits are per /64, so a /48 has 65,536 clients | Low | accepted | The site-wide caps (M2, M3, pricing in flight, both ceilings) are what bound it |
| In-memory counters reset at a restart (L5) | Low | accepted | One instance; the attacker-caused restart (C1) is closed |
| Two first re-prices sent at the same instant can create two drafts | Low | accepted | The spare one lapses in 48 hours |
| `GET /api/admin/stats` loads every row to count | Low | deploy-runbook | Admin only |
| Drawings on cancelled orders are never deleted | Low | order-lifecycle | Their states are that lane's |
| `lingerThenClose` relies on how Node ends a "Connection: close" answer | Low | none | If a Node release changes it, the behaviour falls back to an immediate close, as before |
| A DXF with `NaN` bulges still parses (bad entities are dropped, 100 x 100 outline) | Low | geometry-speed | It is sent to a person, never to checkout; unchanged from before |
| Existing `.env.example` lines still show the old defaults for `PART_INLINE_GEOMETRY_KB` and the parse memory settings | Low | whoever next edits the file | The append-only rule kept them; the appended section gives the new values |

## 11. Running the measurements again

Start nothing by hand: each script starts its own server on a throwaway folder.

```
R="env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1"
T=tools/security/review-uploads
$R node $T/availability.js session 12 1          # C1
$R node $T/availability.js mainthread            # C2, no account
$R node tools/security/availability-fixes/measure-pricing.js 4900 30   # C2, signed in
$R node $T/price-nan.js                          # H1
$R node $T/parser-abuse.js 'NaN|Infinity|scaled|1e999|padding|ELLIPSE|nested'
$R node $T/availability.js queue                 # H2
$R node $T/availability.js pool
REVIEW_DB_MAX_MB=16 $R node $T/availability.js db 0   # H3
UPLOAD_DIR_MAX_MB=200 $R node $T/availability.js storage   # H4
$R node $T/retention-encryption.js retention     # H5, L2
$R node $T/abuse-limits.js off                   # M2, M3
$R node $T/abuse-limits.js on                    # M1
$R node $T/availability.js budget                # L1
$R node $T/availability.js refused
$R node $T/availability.js keys                  # I2
$R node $T/claims.js                             # L6
```
