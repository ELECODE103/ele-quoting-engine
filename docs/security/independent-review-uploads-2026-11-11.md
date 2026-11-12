# Independent attack review: uploads, parsers, availability — 2026-11-11

Branch `security-review-uploads-2026-11-11`, cut from `hardening-2026-11-11` (e4881d3). Review only:
no application code was changed. Every finding below has a script that reproduces it against a
local server, or a file and line. The scripts are in `tools/security/review-uploads/`.

Area reviewed: file handling on the three upload routes, the CAD parsers, the levers that deny
service to real customers, how much one script can create per hour, and the retention sweeps and
encryption at rest. Authentication, injection and browser policy, and payments are other reviewers'
areas; what I tripped over there is marked "outside my area".

## 1. Bottom line

The work done on file handling and on the parser sandbox holds up. I could not get a file written
outside its folder, served back in a way a browser would run, or left behind after a refusal; none
of 59 hostile CAD files crashed the server, leaked a worker or escaped the time and memory limits.

The site can still be taken down, and its prices beaten, from other directions that the hardening
did not cover:

1. **Two small requests take the whole site off the air.** Reopening a quote
   (`GET /api/quote/:id/session`) and pricing a quote (`POST /api/quote`) do their work on the one
   thread that serves every visitor. One anonymous visitor, inside every rate limit, froze the server
   for a median of 35 seconds per health check, and with a different request drove its memory past
   2.6 GB until the operating system killed it.
2. **A doctored STL gets a tenth of the price with checkout open.** A 400 mm block that prices at
   $3,727 and is sent to a person was quoted at $352 and accepted by checkout after one extra
   triangle with an `Infinity` corner was added to the file.
3. **Uploads can be closed to every customer for a week to a month** by filling the 2 GB file
   ceiling (106 seconds, five addresses) or the 256 MB database ceiling (13 minutes, four addresses,
   no file upload at all). Neither recovers by itself in less than 7 to 30 days, a restart does not
   help, and there is no admin screen that clears either.
4. **An order placed on day 8 of a 30-day quote arrives without its CAD file.** No attacker needed.

Sections 3 and 4 list everything by severity with the fix for each.

## 2. How this was done, and its limits

- The real server (`server/index.js`, `NODE_ENV=production`) was started locally through
  `server/testSupport/liveServer.js` with throwaway secrets, two parse workers
  (`PARSE_CONCURRENCY=2`, as on Railway) and default limits unless a line says otherwise.
- Nothing left the machine. Stripe, Cloudflare Turnstile and the mail provider were answered by
  local stubs (`preload-stubs.js`). No live domain was touched.
- Client addresses were set through `X-Forwarded-For`, the way Railway's edge reports them
  (one trusted hop).
- While each hostile file was being read, `/api/health` was polled every 50 ms and the server
  process's memory was sampled.
- **Limits of the evidence.** The test machine has 2 CPUs and was shared with other jobs, so
  latency figures are indicative. It runs Node 22.23; production is Node 20. I could not test how
  Railway's edge treats `X-Forwarded-For`, chunked uploads or request timeouts, nor how much memory
  the Railway service has. Where a conclusion depends on one of those, it says so.

## 3. Findings by severity

| # | Severity | Finding | Where | Class |
|---|---|---|---|---|
| C1 | Critical | Reopening one quote makes the server build a 478 MB answer on the main thread: 16 s frozen, memory past 2.6 GB, process killed | `server/routes/api.js:741-775` | Launch blocker |
| C2 | Critical | Pricing a 100-line quote blocks the main thread; one address inside its limit keeps the site frozen (health check median 35 s) | `server/routes/api.js:507-599`, `:462` | Launch blocker |
| H1 | High | `NaN` / `Infinity` coordinates give a fraction of the price with checkout open ($3,727 → $352) | `server/parsers/fileParser.js:44-96`, `server/services/quoteGate.js:43` | Launch blocker |
| H2 | High | Two requests of ten 1 kB files hold both parse workers for 10 minutes; one address can fill the waiting line | `server/routes/api.js:314-368`, `server/parsers/parsePool.js:93-124` | Launch blocker |
| H3 | High | Draft quotes grow the database to its ceiling: uploads refused for up to 30 days, every save slows the site, survives restart | `server/routes/api.js:629-669`, `server/security/uploadGuards.js:111-134` | Launch blocker |
| H4 | High | The 2 GB file ceiling is filled in under two minutes with files that cost nothing to read; attachments are never freed | `server/security/uploadGuards.js:38-101`, `server/services/fileRetention.js:89-97` | Fix soon |
| H5 | High | CAD files are deleted at 7 days while the quote can be ordered for 30: paid orders and firm-quote requests with no file | `server/services/fileRetention.js:67-82`, `server/routes/orders.js:61` | Launch blocker |
| M1 | Medium | The "verified human" token is not tied to an address or a use count: one solved challenge opens upload and pricing to every address for an hour | `server/security/botGuard.js:108-110`, `:145` | Fix soon |
| M2 | Medium | Firm-quote requests: 10 an hour per address, each emails the shop and stores up to 25 MB that nothing ever deletes, declined or not; no global cap | `server/routes/rfq.js:175`, `server/security/botGuard.js:48-49` | Fix soon |
| M3 | Medium | Registration sends a "confirm your email" message to any address typed: 10 an hour per address, no global cap on outgoing mail | `server/routes/auth.js:170-232` | Fix soon |
| M4 | Medium | Memory: hostile parsing took the process to 1.3 GB, the quote flood to 1.5 GB; the watchdog allows parsing to add 1 GB; Railway stops restarting after 10 crashes | `server/security/limits.js:69-78`, `railway.toml:11` | Verify before launch |
| M5 | Medium | With encryption on, the database still holds full DXF outlines, small preview meshes and file names in the clear; the guide says otherwise | `server/models/partPayloads.js:91-117`, `docs/security/file-encryption.md` | Fix soon (guide today) |
| L1 | Low | Uploads sent without `Content-Length` are never charged to the sender's daily budget on the request form; over-size refusals are not charged anywhere | `server/security/uploadGuards.js:195-222`, `server/routes/api.js:273-278` | Fix soon |
| L2 | Low | A crash or kill during a parse leaves the upload on disk, unencrypted even with a key set, for up to 7 days | `server/routes/api.js:284`, `server/services/fileRetention.js:21` | Fix soon |
| L3 | Low | Zero-size and microscopic models are priced and open for checkout ($191 for a cube 2×10⁻²⁹ mm across) | `server/parsers/fileParser.js:105-232` | With H1 |
| L4 | Low | The memory watchdog stops the longest-running parse, which may be a customer's, not the one using the memory | `server/parsers/parsePool.js:291-296` | Accept or fix with H2 |
| L5 | Low | Every limiter, budget and used-form-token list is in memory: a restart (or a crash an attacker causes, C1) resets them all | `server/security/throttle.js`, `uploadGuards.js:138` | Accept (one instance) |
| L6 | Low | A 4 kB DXF adds 50 kB to the database (ten times its size); 2,000 an hour per address is allowed | `server/security/limits.js:53` | With H3 |
| I1 | Info | File names with non-ASCII characters are stored garbled (`Gehäuse.stl` → `GehÃ¤use.stl`) | multer default charset | Accept / fix later |
| I2 | Info | An address reported with a port (`203.0.113.9:51234`) becomes its own limiter key per port | `server/security/clientKey.js:40` | Accept (Railway does not send ports) |
| I3 | Info | STEP "30 second" timeout still races a synchronous call and never fires; harmless now that the pool stops the worker at 60 s | `server/parsers/fileParser.js:388-408` | Accept |

### Launch blockers

C1, C2, H1, H2, H3, H5. Each is cheap to exploit (or, for H5, happens with no attacker) and each
has a fix of a day or less. M4 is a check, not a fix: confirm the Railway service's memory.

### Fix soon (first two weeks)

H4, M1, M2, M3, M5, L1, L2, L6.

### Accept

L4, L5, I1, I2, I3, with the notes given.

## 4. The findings

### C1 — Reopening a quote can kill the server (Critical)

**Route.** `GET /api/quote/:id/session`, `server/routes/api.js:741-775`. For every line of the quote
it reads the part's preview mesh from its file (`:752`), parses it, and builds one JSON answer, all
on the main thread. A quote may have 100 lines (`:462`) and nothing stops the same part being on
all of them. The route is open to anyone holding the quote id, and the bot check does not cover it.

**Reproduction.** `node tools/security/review-uploads/availability.js session` (100 lines) and
`… session 25 1` (25 lines). Three anonymous requests set it up: upload the repository's own 2 MB
STEP fixture, save a quote with that part on every line, reopen the quote.

| Quote | Answer size | Time | Server memory | Health check while it ran |
|---|---|---|---|---|
| 25 lines | 119 MB | 15.0 s | 420 → 1,032 MB | worst 9.4 s, median 8.1 s |
| 100 lines | 478 MB | 16.6 s | 421 → over 2,670 MB | worst 8.7 s; then the process was killed by the kernel's out-of-memory killer (`dmesg`: `Killed process … anon-rss:2189492kB`) |

The limit on this route is 60 requests per 15 minutes per address.

**Impact.** One visitor with a 2 MB file can freeze the site for 8 to 16 seconds per request, 60
times per 15 minutes, or crash it outright. `railway.toml` restarts a crashed service 10 times and
then stops, so a handful of repeats leaves the site down until someone redeploys. Each crash also
resets every rate limit and budget (L5). If the server survives, each request sends up to 478 MB:
at Railway's metered egress that is real money per hour per address.

**Fix.**
1. Send each distinct part's mesh once per answer (a map by part id), not once per line.
2. Do not parse and re-serialise the mesh at all: serve it from its own route
   (`GET /api/parts/:id/mesh`, with the part's edit key) by streaming the file, and give the session
   answer only the part ids. Decrypt in a stream when encryption is on.
3. Cap the total preview bytes in one answer (say 30 MB) and answer `previewUnavailable` past it.
4. Refuse a quote that names the same part on more than a few lines, and lower `MAX_QUOTE_LINES`
   to what the builder offers (it adds parts ten at a time; 25 is generous).

### C2 — Pricing blocks the whole site (Critical)

**Route.** `POST /api/quote`, `server/routes/api.js:507-599`. For every line: the part is read
from the database, and for a detailed part its geometry file is read and parsed again (`:522`); the
whole materials table is read (`:531`); the DFM rules run (`:577`); then the price and six
quantity-break prices are computed (`server/services/pricingEngine.js:124`). All on the main
thread, up to 100 lines, and the same part may be on every line.

**Reproduction.** `node tools/security/review-uploads/availability.js mainthread`. A 148 kB DXF (a
plate with 4,900 holes, accepted and priced at $1,367 with checkout open) is uploaded once; then one
address sends 100-line quotes of it, eight at a time, for 30 seconds.

| Measure | Result |
|---|---|
| One 1-line quote of that part | 115 ms |
| One 100-line quote | about 4.3 s of main-thread time |
| 14 requests from one address in 60 s, none rate-limited | median answer 30.2 s |
| `/api/health` during the run | median 34.8 s, worst 37.1 s (82 samples) |

The pricing limit is 40 per 10 seconds and 300 per 15 minutes per address. 300 requests of 4.3 s is
1,290 seconds of work in a 900-second window: one address keeps the server permanently busy.

It does not need the special file. With a plain 20 mm cube a 100-line quote takes about 0.3 s of
main-thread time (`availability.js db`: 287–346 ms each on a small database), and one address is
allowed 40 of them every 10 seconds, which is 12 seconds of work per 10 seconds.

**Impact.** Every page, sign-in, checkout return and Stripe webhook waits behind the pricing loop.
The site looks down. Cost to the attacker: a few kilobytes a second from one address.

**Fix.**
1. Load each distinct part once per request and reuse it for every line that names it.
2. Cache the DFM result per part, process, material and thickness; it does not change between
   re-prices.
3. Read the materials, finishes and lead times once per request, not once per line.
4. Give a quote a time budget (for example 250 ms): past it, stop and answer "this quote is too
   large for the instant price" with the firm-quote offer. Or run quotes of more than a few lines in
   the worker pool.
5. Allow one pricing request in flight per address, and count the limiter by lines, not requests.
6. Lower `MAX_QUOTE_LINES` (see C1).

### H1 — `NaN` and `Infinity` in a model beat the price and the gate (High)

**Where.** Binary STL coordinates are read with no check that they are numbers
(`server/parsers/fileParser.js:44-73`). The ASCII pattern accepts `e`, `+-` and `1e999` as numbers
(`:80-81`). One such value turns the bounding box, area and volume into `NaN` or `Infinity`
(`:110-162`), which the database stores as `null` (`server/models/SqliteDB.js:144`, and
`JSON.stringify`). Pricing then works from empty measurements, and the checkout gate has no rule
for "the measurements are missing" (`server/services/quoteGate.js:43-130`): the size and DFM
checks that would send the part to a person cannot fire on a size that is not there.

**Reproduction.** `node tools/security/review-uploads/price-nan.js`.

| File | Measured | CNC | 3D print |
|---|---|---|---|
| Honest 400 mm block | 400 × 400 × 400 mm | $3,489.28 each, sent to a person | $5,827.20, sent to a person |
| Same block + one stray triangle with an `Infinity` corner | box, area, volume all empty | **$339.16, open for card checkout** | **$75.48, open for card checkout** |
| Same block + a `NaN` corner | all empty | $12,856, sent to a person | $3,409, sent to a person |
| 20 mm cube with one `NaN` vertex (`parser-abuse.js`) | all empty | $139.53, checkout open | $18.33, checkout open |

The script then registers a buyer and calls checkout for the `Infinity` block: HTTP 200, a Stripe
session for $352.04 (Stripe is a local stub).

**Impact.** Anyone who can edit a file can get a large part quoted at about a tenth of its price
and pay for it. The shop then holds a paid order it must either make at a loss or cancel and
refund. The traveler for that order shows no dimensions.

**Fix.**
1. Refuse any non-finite coordinate in every parser, with the "file is damaged" message: binary and
   ASCII STL, 3MF vertices and transforms, DXF, and the arrays OpenCascade returns.
2. After parsing, refuse a model whose bounding box is not three finite numbers within sane bounds
   (for example 0.01 mm to 10 m), whose area is not positive, or whose volume is not finite. This
   also closes L3.
3. In the gate: any line whose stored geometry has a missing size, area or volume goes to a person.
4. In checkout: re-check the same before a Stripe session is made.

Outside my area in the strict sense (price integrity), but item 2 of the brief asked for it.

### H2 — The parse pool is cheap to occupy (High)

**Where.** `server/routes/api.js:314-368`: one request may carry 10 files and they are parsed one
after another; when a file hits the 60-second limit the loop goes on to the next (`:366`). So one
request can hold a worker for 10 × 60 seconds. `server/parsers/parsePool.js:120-124` lets an
address *run* one parse at a time, but the waiting line (`:93-106`, 8 places) has no per-address
share. Files that reach the limit are trivial to write:
`server/geometry/dxf/parse.js:487-488` caps one block array at 10,000 copies but not eight nested
ones (10,000⁸), and `:437` loops for ever on an ellipse parameter of 1e308.

**Reproduction.** `node tools/security/review-uploads/availability.js pool` and `… queue`.

| Attack | Cost | Effect, measured |
|---|---|---|
| Two addresses, one request each, ten 950-byte DXFs per request | 19 kB in total, 2 requests | Both workers held for 605 s. Of 31 customers uploading a 684-byte cube during that time, 14 were told "busy" after waiting 30 s; the other 17 waited about 20 s |
| One address sends 12 single-file requests | 12 kB | Its 8 waiting requests fill the line. Of three customers arriving together, one got a worker (and took 42 s for an 18 s file), two were refused at once with 503 |

Fairness is enforced per address for running parses only. An IPv6 customer's /64 is one address;
a /48 is 65,536 of them.

**Impact.** The instant quote is the product. Two tiny requests every ten minutes, from two
addresses, take it away from about half the visitors; a few more addresses take it from all of
them. The rest of the site stays up (worst health check 268 ms).

**Fix.**
1. After a timeout or a memory stop, refuse the rest of that request's files without parsing them.
2. Give each address a budget of parse seconds (for example 90 s per 15 minutes) and a pause after
   a timeout; give each address at most two places in the waiting line.
3. A DXF that takes more than a few seconds is not a part outline: give DXF its own limit (10 s).
4. Cap the total number of block instances walked in a DXF, guard the ellipse loop against
   non-finite and enormous parameters, cap spline control points.
5. Keep one worker for addresses that have not timed out recently.

### H3 — Draft quotes fill the database (High)

**Where.** Every `POST /api/quote` without a quote id inserts a row
(`server/routes/api.js:666`). A 100-line quote of a 684-byte cube is a 296 kB row (each line stores
its full price breakdown and six quantity breaks). Nothing limits new rows except the pricing
limiter (300 per 15 minutes per address), and the database ceiling is checked only on uploads
(`server/security/uploadGuards.js:205`), so quotes keep growing the file past it. Draft quotes stay
30 days (`server/services/rowRetention.js`). The whole file is rewritten on every write
(`server/models/database.js:353-363`).

**Reproduction.** `node tools/security/review-uploads/availability.js db 1600`.

| Quotes sent | Database | Time for the last quote | Server memory | Addresses used |
|---|---|---|---|---|
| 1 | 0.4 MB | 0.56 s | 186 MB | 1 |
| 300 (one address's 15-minute allowance) | 84.9 MB | 0.43 s | 664 MB | 1 |
| 600 | 169.6 MB | 1.12 s | 696 MB | 2 |
| 900 | 254.4 MB | 0.97 s | 961 MB | 3 |
| 925 | 261.4 MB | 0.99 s | peak 1,469 MB | 4 |

At 925 quotes (772 seconds, four addresses; one address alone needs about 45 minutes) a real
customer's upload was refused: "We can't take new files right now" (`code: storage-full`). After a
restart it was still refused, and the server started at 1,321 MB of memory. During the run the
health check's median was 431 ms and its worst 2.9 s.

**Impact.** No file is uploaded at all: about 7 MB of small requests closes uploads for every
customer for up to 30 days. From then on every write anywhere (a quote, a sign-in, an order)
blocks the site for about a second. The attacker can keep going past the ceiling; memory follows
at roughly five times the file. Cleanup is by hand in the database; there is no admin action.

The integration report marks the database item (O1) as fixed. Part rows did shrink (measured: 5.1 kB
for a cube). Quote rows were not part of that fix.

**Fix.**
1. Limit *new* quote rows per address (for example 30 an hour, 100 a day). A buyer re-prices one
   row; only a script makes hundreds.
2. Check the database ceiling before inserting a quote, an RFQ or an account, not only a part.
3. Store a compact line (ids, quantities, the prices shown), not the whole breakdown and break
   table; lower the line cap (C1).
4. Let an anonymous draft nobody reopened lapse in 48 hours, and give the admin a "clear old
   drafts" button.
5. The real fix remains a native SQLite driver that writes only what changed.

### H4 — The 2 GB file ceiling (High)

**Where.** `server/security/uploadGuards.js:38-101` and the daily budget of 500 MB per address
(`:138-177`). The ceiling is smaller than what one address may send in the 7 days files are kept
(7 × 500 MB). A file does not have to be expensive to be large: the ASCII STL reader ignores
everything that is not a facet, so a cube followed by 49 MB of blanks is accepted in 2.2 seconds.

**Reproduction.** `node tools/security/review-uploads/availability.js storage`.

| Step | Result |
|---|---|
| Four addresses, one request each of ten 49 MB padded cubes | 1,960 MB stored in 38 s |
| A fifth address tops up with two files | 2,048 MB stored, 106 s and 2.5 GB uploaded in all |
| A real customer uploads a 9 kB STEP | 503 `storage-full` |
| Restart | still full |

**What restores service.** CAD files not on an order or an open request go when they are 7 days
old, so the door reopens a week after the attacker stops, and he need not stop. Files on an open
firm-quote request stay until the owner closes it. **Attachments on firm-quote requests are never
deleted, declined or not** (`server/services/fileRetention.js:89-97` keeps every drawing any row
points at; `retention-encryption.js retention` shows a request declined 400 days ago still has its
file). There is no admin action that deletes a request, a part or a file. With attachments the
ceiling is reached by 82 requests of 25 MB (one address, three to five days) and then stays reached until
someone raises `UPLOAD_DIR_MAX_MB` or deletes files on the volume by hand. The server report's O6
says recovery is "the owner declining spam requests"; for attachments that does not free anything.

**Fix.**
1. Refuse an STL whose size is far beyond what its triangles need (ASCII: more than about 400
   bytes per facet; binary is already exact).
2. Cap the bytes one address may have *stored* at once, not only sent per day.
3. When usage passes 80%, delete the oldest uploads no quote, order or request refers to, instead
   of refusing new customers.
4. Delete an attachment when its request is declined, lost or expired (after a grace period), and
   give the admin a delete action for requests.
5. Email the owner at 80%; a log line is not seen.

### H5 — Files deleted while the quote can still be ordered (High)

**Where.** `server/services/fileRetention.js:67-82` keeps the CAD file of a part on an order or an
open request. A part on a draft quote is not in that list, so its file is deleted at 7 days. The
quote's price holds for 30 days, and neither checkout (`server/routes/orders.js:61`) nor the
request form (`server/routes/rfq.js:175`) checks that the files are still there.

**Reproduction.** `node tools/security/review-uploads/retention-encryption.js retention`.

```
8 days later (sweeps ran at start) — CAD files on disk: 0; File retention: removed 2 upload(s) older than 168h
the quote on day 8 — HTTP 200, status draft, expired=false, total 233.05
checkout → HTTP 200 (order created, sent to Stripe); admin download of the ordered part → HTTP 404 File missing on disk
request → HTTP 201; admin download → HTTP 404 File missing on disk
```

**Impact.** A buyer who gets a quote on Monday and orders the following Wednesday pays for an
order the shop has no model for. The same for a firm-quote request. The shop has to email for the
file and trust that what comes back is what was priced.

**Fix.** Either keep a file for as long as an unexpired quote refers to its part, or (keeping the
"deleted after 7 days unless you order" promise) have checkout and the request form check every
part's file and answer "upload this file again" when one is gone. Re-pricing a quote should restart
the 7 days for its files.

### M1 — The verified-human token (Medium)

`server/security/botGuard.js:145` issues a one-hour token with no claims; `:108-110` accepts it
from anyone. `abuse-limits.js on`: a token obtained from one address uploaded a part from another
(HTTP 200). The only limit is 30 new tokens an hour per address. With Turnstile on, one solved
challenge therefore opens upload and pricing to every address for an hour, and C1, C2, H2, H3 and
H4 cost one challenge each. The integration report lists this as Low; with those findings open it
is the reason Turnstile will not slow them down.

**Fix.** Put the client key in the token and check it; count uses per token (a buyer makes a few
hundred calls an hour, not tens of thousands); put `GET /api/quote/:id/session` behind the same
gate as the other quote-tool routes.

### M2 — Firm-quote requests (Medium)

Measured (`abuse-limits.js`): 10 requests an hour and 30 a day per address, each with an attachment
of up to 25 MB, each sending one email to the shop's inbox. The count is per address with no total:
100 addresses are 1,000 requests and 1,000 emails an hour. The attachment is written to disk before
any form check runs (`server/routes/rfq.js:175`: `attachment` comes before `checkForm`), though a
refused request's file is removed. Nothing ever deletes an accepted request or its attachment (H4).
With the bot check off (today) none of this needs a challenge.

**Fix.** A site-wide cap on requests per hour from unverified senders (past it, hold them without
emailing and show one digest); the delete action and attachment sweep from H4; run the cheap form
checks from headers before the body is read.

### M3 — Email to addresses a stranger types (Medium)

`POST /api/auth/register` sends "confirm your email address" to whatever address is entered
(`server/routes/auth.js:170-232`). Measured: 10 an hour per address (30 a day), no site-wide cap.
With the bot check on, firm-quote confirmations add 8 a day per address and 4 a day per recipient.
From many addresses this is a way to send unwanted mail from the shop's domain; enough complaints
and the mail provider suspends the account, and order confirmations and password resets stop.

**Fix.** A site-wide hourly cap on mail to unconfirmed addresses, with an alert to the owner when
it trips. Turnstile on the registration form (planned) is the main defence; do not launch without it.

### M4 — Memory (Medium, verify)

Peak memory of the server process, measured: 1,229 MB for one hostile STL (25 MB of random
triangles); 1,280 MB with two at once, when the watchdog fired (`Parse pool: parsing has added
1054 MB`); 1,469 MB during the quote flood (H3); over 2,670 MB for C1. The watchdog lets parsing add
1,024 MB to whatever the process already uses, and a worker's heap may reach 768 MB. If the Railway
service has less than about 2 GB, a hostile upload kills the whole process, not one worker, and
after 10 such restarts Railway leaves it down (`railway.toml:11`).

**Action.** Check the service's memory limit. Either give it 2 GB or more, or set
`PARSE_RSS_LIMIT_MB=512` and `PARSE_MAX_HEAP_MB=384`. Raise `restartPolicyMaxRetries` or use
`ALWAYS`.

### M5 — What encryption does not cover (Medium)

`retention-encryption.js encryption`, with a throwaway key: every stored file had the `.enc`
suffix and no readable content was found in any file under `data/` except the database. In
`quoting.db`, in the clear: the customer's file name; the outline coordinates and hole centres of a
small DXF (the whole design of a flat part, kept in the row when under 64 kB); the preview mesh of
a small model (kept in the row when under 16 kB). `docs/security/file-encryption.md` says the
database holds "the measurements of every uploaded part (size, volume, hole counts)" and that "the
3D preview mesh is no longer in the database". Both understate it.

**Fix.** Correct the guide now. Then either write every DXF profile and mesh to an encrypted
payload file whatever its size when a key is set, or encrypt those two columns.

### L1 — Bytes that are not counted

`node tools/security/review-uploads/availability.js budget` and `… refused`, with the daily budget
set to 20 MB:

```
with Content-Length (each attachment 8 MB): 201  201  refused  429  429  refused   → stored 16 MB
chunked, no Content-Length:                  201  201  201  201  201  201          → stored 64 MB
four 51 MB files (over the 50 MB limit), no Content-Length: 413 413 413 413 — 204 MB received and written, daily budget 20 MB
```

`admit()` judges and charges the request form by its `Content-Length` header
(`server/security/uploadGuards.js:195-222`); a chunked request has none, so it is charged nothing
and the storage ceiling is checked against zero incoming bytes. The server report's "refused bytes
count too" is true for a content mismatch and false for an over-size file. Whether Railway's edge
forwards chunked uploads unchanged I could not test. **Fix:** count what multer actually received,
on every route and on every outcome, in a `finally`.

### L2 — Leftovers after a crash

`retention-encryption.js`: a server killed during a parse left the upload in `data/uploads` with
its plain extension; six days and one restart later it was still there, and with a key set it was
still unencrypted. No row points at it, so it goes at 7 days. **Fix:** at startup, delete files in
`data/uploads` that no part row names and that are older than a few minutes.

While a file is being read it is on the volume unencrypted for up to 90 seconds (60 s parse, 30 s
wait). That is inherent in parsing from disk and is acceptable; the guide should say it.

### L3, L4, L5, L6, I1–I3

- **L3.** A cube scaled by 10⁻³⁰ prices at $191.62 (CNC) and $15.17 (print) with checkout open; a
  3MF with one degenerate triangle at $338. Closed by H1's size check.
- **L4.** `parsePool.js:291-296` stops the oldest running parse when memory is over. In the
  two-at-once test it stopped both hostile ones; with a customer's parse the older, the customer
  loses. Stop the newest, or track memory per worker.
- **L5.** `availability.js keys`: an address at its upload limit (429) got 200 on the first request
  after a restart. Acceptable for one instance, but note that C1 lets an attacker cause the restart.
  Used form tokens are also forgotten, so a token can be spent again within its 12 hours.
- **L6.** `claims.js`: 100 cubes add 5.1 kB each to the database; 100 DXFs of 4.4 kB add 50 kB
  each. At 2,000 parts an hour per address that is 100 MB an hour; rows stay 7 days. Lower
  `PART_INLINE_GEOMETRY_KB` to 8.
- **I1.** multer reads a file name as Latin-1 unless told otherwise; set `defParamCharset: "utf8"`.
- **I2.** `clientKey.js:40` keeps an unrecognised address string as the key, so `ip:port` is a new
  key per port. Strip a port before classifying. Not reachable through Railway as far as I know.
- **I3.** As the table says.

## 5. Item 2: hostile inputs, measured

`node tools/security/review-uploads/parser-abuse.js [filter] [--out file.jsonl]`, then
`report-table.js`. One input at a time against a fresh server; "added" is memory above the level
just before the upload (the process's own level rises during a long run and is included in the
peak). Price columns show the first listed material for each process.

| Input | Size | Outcome | Seconds | Peak memory, MB (added) | Worst health check, ms | Price if accepted |
|---|---|---|---|---|---|---|
| STL control: 20 mm cube (first upload after a start) | 684 B | accepted | 1.1 | 153 (+23) | 599 | CNC $194.83, print $18.63 (checkout open) |
| STL header count 4,294,967,295, 12 triangles present | 684 B | refused: content check | 0 | 167 (+0) | 0 | |
| STL header count 500,000, 12 triangles present | 684 B | refused: content check | 0 | 168 (+0) | 0 | |
| STL header count 1, 12 triangles present | 684 B | accepted as 1 triangle | 0 | 169 (+0) | 0 | CNC $132.59, print $16.57 (to a person) |
| STL one vertex `NaN` | 684 B | accepted | 0.1 | 179 (+0) | 0 | **CNC $139.53, print $18.33 (checkout open)** |
| STL every coordinate `NaN` | 684 B | accepted | 0 | 183 (+0) | 0 | CNC $339.16, print $75.48 (to a person) |
| STL one vertex `+Infinity` | 684 B | accepted | 0 | 185 (+0) | 0 | **CNC $339.16, print $75.48 (checkout open)** |
| STL 200 mm cube + one `NaN` coordinate | 734 B | accepted | 0 | 185 (+0) | 0 | CNC $2,122, print $564 (to a person) |
| STL 200 mm cube + inverted copy (volume cancels) | 1.3 kB | accepted | 0.1 | 187 (+0) | 2 | CNC $2,697, print $577 (to a person) |
| STL cube scaled 10³⁰ | 684 B | accepted | 0 | 188 (+0) | 0 | CNC $2.9×10⁸⁹ (to a person) |
| STL cube scaled 10⁻³⁰ | 684 B | accepted | 0 | 188 (+0) | 0 | **CNC $191.62, print $15.17 (checkout open)** |
| STL binary with a `solid` header | 684 B | accepted, read correctly | 0 | 189 (+0) | 0 | as the control |
| STL ASCII, numbers `e` (read as `NaN`) | 1.1 kB | accepted | 0 | 190 (+0) | 0 | CNC $139.53 (to a person) |
| STL ASCII, numbers `1e999` (`Infinity`) | 1.1 kB | accepted | 0 | 190 (+0) | 0 | **CNC $339.16, print $75.48 (checkout open)** |
| STL ASCII cube + 49 MB padding | 49.0 MB | accepted | 2.2 | 280 (+150) | 382 | as the control |
| STL ASCII, 1 facet + 49 MB of vertex lines (3.9 M vertices) | 49.0 MB | accepted | 4.5 | 726 (+484) | 191 | CNC $132.59 (to a person) |
| STL 500,000 random triangles | 23.8 MB | stopped: memory (heap 768 MB) | 21.1 | 1,229 (+904) | 124 | |
| STL 100,000 random triangles | 4.8 MB | stopped: memory | 31.1 | 1,188 (+779) | 206 | |
| STL 500,000 coplanar grid triangles | 23.8 MB | accepted | 5.6 | 701 (+345) | 146 | CNC $869 (to a person) |
| STL 500,000 degenerate triangles | 23.8 MB | stopped at 60 s | 60.2 | 658 (+279) | 80 | |
| 3MF control: box | 750 B | accepted | 0.1 | 189 (+0) | 34 | as the control |
| 3MF model declares 1 MB, inflates to 2 GB | 2.0 MB | refused | 0 | 405 (+0) | 0 | |
| 3MF model declares 60 MB, inflates to 2 GB | 2.0 MB | refused | 0 | 406 (+0) | 0 | |
| 3MF honest 60 MB of blanks (1000:1) | 60 kB | refused: bomb | 0 | 408 (+0) | 0 | |
| 3MF 60 MB of identical `<vertex/>` | 150 kB | refused: bomb | 0 | 602 (+0) | 0 | |
| 3MF 60 MB of vertices with random coordinates (1.5 M, 1 triangle) | 17.5 MB | accepted | 43 | 871 (+753) | 196 | CNC $10,709 (to a person) |
| 3MF 900 directory entries on one local file (overlap) | 58 kB | accepted, read correctly | 0.1 | 422 (+13) | 14 | as the control |
| 3MF 60,000 overlapping entries | 3.7 MB | refused: too many | 0.1 | 422 (+0) | 3 | |
| 3MF data-descriptor flag, zero local sizes | 750 B | accepted, read correctly | 0 | 422 (+0) | 0 | as the control |
| 3MF ZIP64 record claims 2⁴⁰ entries | 826 B | refused | 0 | 192 (+0) | 0 | |
| 3MF XML nested 100,000 deep | 1.1 kB | refused | 0 | 424 (+0) | 0 | |
| 3MF XML entity bomb | 627 B | refused (entities not expanded) | 0 | 425 (+0) | 0 | |
| 3MF one element with 200,000 attributes | 452 kB | accepted | 2.2 | 597 (+171) | 44 | CNC $338, print $75 (checkout open, see L3) |
| 3MF component fan-out 8¹⁵ over a 2,000-vertex mesh | 1.0 kB | stopped at 60 s | 60 | 602 (+0) | 215 | |
| 3MF self-referencing component | 596 B | refused: loop | 0 | 397 (+0) | 0 | |
| DXF control: plate with 4 holes | 276 B | accepted | 0 | 192 (+0) | 0 | routing $103.57 (checkout open) |
| DXF block inserts itself | 274 B | accepted (loop cut at depth 8) | 0 | 400 (+0) | 0 | routing $99.49 (checkout open) |
| DXF 8 nested 100×100 block arrays, empty leaf | 950 B | stopped at 60 s | 60 | 425 (+20) | 89 | |
| DXF ELLIPSE with parameter 1e308 | 214 B | stopped at 60 s | 60 | 416 (+2) | 68 | |
| DXF 100,001 entities | 3.7 MB | refused: too large | 0.6 | 568 (+170) | 134 | |
| DXF 20,000 crossing lines | 753 kB | stopped at 60 s | 60 | 933 (+361) | 74 | |
| DXF plate with 4,900 holes | 148 kB | accepted | 4.8 | 513 (+104) | 51 | routing $1,367 (checkout open); the file used in C2 |
| DXF one polyline, 1,000,000 vertices | 23.6 MB | refused | 9.2 | 1,156 (+650) | 105 | |
| DXF self-crossing zig-zag, 20,000 vertices | 292 kB | refused | 0.1 | 395 (+20) | 5 | |
| DXF SPLINE, 50,000 control points | 1.4 MB | stopped at 60 s | 60.2 | 307 (+114) | 84 | |
| DXF 49 MB of empty group pairs | 49.0 MB | stopped: memory | 14.7 | 1,184 (+771) | 89 | |
| DXF coordinates 1e300 | 211 B | refused | 0.1 | 429 (+3) | 8 | |
| DXF `NaN` / `Infinity` / 1e308 bulges, negative and zero radius | 245 B | accepted (bad values read as 0) | 0 | 197 (+0) | 0 | routing $100.78 (to a person) |
| STEP control: tube | 9.4 kB | accepted | 2.7 | 344 (+144) | 82 | CNC $231.84, print $33.41 (checkout open) |
| STEP plate with 400 holes (repository fixture) | 1.9 MB | accepted | 18.4 | 783 (+354) | 403 | CNC $584.73 (checkout open) |
| STEP 400-hole plate ×6 | 12.1 MB | stopped at 60 s | 60.1 | 1,019 (+512) | 64 | |
| STEP 400-hole plate ×24 | 49.0 MB | stopped at 60 s | 60.3 | 1,038 (+484) | 262 | |
| STEP self-referencing entities and a mapped-item loop | 637 B | refused | 0.3 | 716 (+12) | 4 | |
| STEP mapped-item tree, 4¹² instances | 12.5 kB | stopped at 60 s | 60 | 839 (+113) | 109 | |
| STEP 49 MB unterminated entity | 49.0 MB | stopped at 60 s | 60.2 | 765 (+59) | 60 | |
| STEP 1,000,000 nested parentheses | 1.9 MB | refused | 2 | 790 (+83) | 16 | |
| IGES control: box with hole | 17.6 kB | accepted | 1.3 | 406 (+44) | 101 | CNC $198.19 (checkout open) |
| IGES 20 MB of transformation records | 20.0 MB | refused | 6.8 | 836 (+39) | 17 | |
| IGES every pointer rewritten to entity 1 | 17.6 kB | refused | 0.1 | 713 (+6) | 10 | |

**What the table says.**

- **Timeout:** every input that ran long was stopped at 60.0–60.3 seconds, including OpenCascade
  spinning inside WebAssembly. `worker.terminate()` does interrupt it.
- **Memory:** JavaScript memory is capped by the worker's 768 MB heap (three inputs were stopped
  there, at 1.2 GB for the whole process). The separate watchdog for WebAssembly and buffer memory
  fired only when two heavy files ran at once (`availability.js memory`: peak 1,280 MB). No single
  STEP or IGES I built took OpenCascade past about 510 MB added. I did not find an input that grows
  WebAssembly memory faster than the watchdog's half-second check; I cannot say there is none.
- **Main thread:** worst health check during any single parse was 403 ms (the 2 MB STEP: copying its
  result back and storing it), apart from 599 ms on the very first upload after a start (an earlier
  run of the same cube measured 8 ms). Typical worst 60–200 ms, median 1–8 ms. The parser sandbox keeps the
  site responsive. C1 and C2 are not parser problems.
- **Aftermath:** 0 of 59 left a file in `data/uploads`; 0 left an extra thread; a cube uploaded
  after each one was priced normally; the process never exited. After 90 parses killed in a row
  (`availability.js creep 90 3000`) memory settled at 445 MB and stayed there, with the same thread
  count: no leak that I could see, though the memory is not handed back while idle.
- **Prices:** `NaN`, `Infinity` and near-zero geometry do reach pricing and do produce low prices
  with checkout open (H1, L3). No input produced a zero or negative price; the pricing guard for
  non-finite totals was never the thing that stopped one.
- **ZIP:** lying sizes, a truthful 1000:1 entry, 60,000 overlapping entries and a false ZIP64 count
  were all refused before anything was unpacked. Overlapping entries under the entry limit and a
  data-descriptor header are read correctly and harmlessly.

## 6. Item 3: availability levers

| Lever | Cheapest way | Measured | What restores service |
|---|---|---|---|
| Parse workers (2) | Two requests of ten 1 kB DXFs from two addresses | Both held 605 s; 14 of 31 customers refused, the rest wait about 20 s | Automatic when the requests end; they can be repeated for ever within every limit |
| Waiting line (8) | One address, nine or more single-file requests | Two of three simultaneous customers refused at once | Automatic after 30 s |
| Per-address fairness | — | Enforced for running parses (1 per address); not for the waiting line; a /48 of IPv6 is 65,536 addresses | — |
| Main thread | C1: one request. C2: about one request every 4 s from one address | Health check 8–37 s | Automatic when the requests stop; C1 at 100 lines kills the process |
| File ceiling (2 GB) | Five addresses, 2.5 GB of padded STL, 106 s. Or one address over five days. Or 82 firm-quote attachments of 25 MB | Customer's 9 kB STEP refused | CAD: 7 days after the attack stops. Attachments: never, by hand only. Not by restart |
| Database ceiling (256 MB) | 925 draft quotes of 100 lines: four addresses, 13 minutes, about 7 MB sent. Or one address, 45 minutes | Customer's upload refused; saves take about 1 s | 30 days (draft hold), or by hand. Not by restart |
| Daily byte budget (500 MB) | One request of ten 49 MB files uses it | 429 `daily-upload-limit` for that address only | 24 hours, or a restart |

**Are the per-address keys bypassable?** `node tools/security/review-uploads/availability.js keys`.

- `X-Forwarded-For` with one trusted hop: only the right-most entry is used. Five requests with
  different left-hand entries and the same right-hand one shared one limit (200 200 200 429 429).
  Safe as long as Railway's edge appends the real address on the right, which I could not test.
- IPv4-mapped IPv6 (`::ffff:a.b.c.d`, in dotted, hex and full forms): folded to the IPv4 address.
- IPv6: five addresses in one /64 share one limit; five /64s in one /48 each get their own. A /48
  costs nothing from a tunnel broker, so every per-address number in section 7 can be multiplied
  by up to 65,536 by an attacker who bothers. The in-memory tables hold 50,000 keys and drop the
  oldest tenth when full (`throttle.js:11`, `uploadGuards.js:140`), which also resets the oldest
  counters.
- NAT64, 6to4 and IPv4-compatible forms of one IPv4 address are separate keys. The client does not
  choose how the edge reports it, so this is not a bypass in practice.
- An address with a port is a new key per port (I2).

**What survives a restart.** Files on disk, the database, and therefore both ceilings (storage is
re-measured from disk). **What resets:** every rate limiter, the daily byte budgets, the form
counters per address and per email, the confirmation-email caps, used form tokens, duplicate
suppression, the parse queue. Sign-in pauses are in the database and survive.

## 7. Item 4: what one script can create

`node tools/security/review-uploads/abuse-limits.js off` and `… on`. Each figure was counted
against the running server from one address until the first refusal. "Per hour" is four 15-minute
windows where the limit is per 15 minutes.

| What | From one address (one IPv4 or one IPv6 /64) | Enforced by | Key | Measured |
|---|---|---|---|---|
| Accounts | 10 per hour, 30 per day | `routes/auth.js:70-77` (10/h); `security/botGuard.js:48-49` (10/h, 30/day, shared with requests) | client key | 10, then 429 |
| Draft quotes (new rows) | 1,200 per hour, up to 100 lines each | `security/rateLimits.js:59-60` (40 per 10 s, 300 per 15 min) | client key | 300 in 76 s, then 429 |
| Parts | 2,000 per hour | `index.js:57-65` (50 uploads per 15 min) × 10 files (`limits.js:33`); 500 MB per day (`uploadGuards.js:138`) | client key | 500 in 50 requests, then 429 |
| Firm-quote requests | 10 per hour, 30 per day | `botGuard.js:48-49`; `index.js:114-122` (20/h, never reached) | client key; also 6/h and 20/day per email typed | 10, then 429 |
| Attachments | 10 per hour on requests (25 MB each); 20 per hour quote drawings, one kept per quote | as above; `rateLimits.js:66` | client key | 32 files on disk after 32 requests from four addresses |
| Email to the shop's inbox | 10 per hour (one per request) | follows the request limit | client key | 32 for 32 requests |
| Email to addresses the script types | 10 per hour, 30 per day ("confirm your email"). With the bot check on, also 8 per day request confirmations, 4 per day per recipient | registration limits; `botGuard.js:53-54` | client key; recipient | 10 confirmation emails; with the check on, 26 request confirmations for 32 requests |
| Password-reset email | 3 per hour to one account's address, 5 requests per hour per address | `routes/auth.js:88-89` | recipient; client key | 3 sent for 5 requests |
| Stripe checkout sessions | about 800 per hour, all on one order of one account | only the general limiter, `index.js:45-54` (200 per 15 min) | client key | 198, then 429 |
| Unpaid orders in the admin list | one per quote, up to about 200 per 15 minutes | only the general limiter (each needs one quote and one checkout call) | client key | 60 of 60 tried |
| PDF documents | 0 | every `/api/pdf` route is admin-only | — | anonymous 401, customer 403 |

**With the bot check off (today):** nothing above needs a challenge.

**With the bot check on (verifier stubbed):** an upload with no check is refused (403). After one
solved challenge the upload, part and quote figures are unchanged, and the token works from any
address (M1). Accounts and requests need a fresh solved challenge each; solving services sell them
for a few dollars per thousand.

**From 100 IPv4 addresses:** multiply by 100 (1,000 accounts, 1,000 requests and 1,000 emails to
the shop an hour; 3,000 a day). **From an IPv6 /48:** multiply by up to 65,536; in practice the
server's own speed and the two ceilings are the only bounds, because no limit is site-wide.
I verified that a second IPv4 address and a second /64 start with a fresh count; the pool totals
are arithmetic, not a 100-address run.

**Cheapest attack that costs a day of cleanup:** H3. About 7 MB of pricing requests, no upload, 13
minutes from four addresses or 45 from one. Uploads close for every customer for up to 30 days,
the site slows on every save, and the only cure today is editing the database by hand.
**Cheapest outage:** C1, four requests. **Cheapest that costs money:** H1 (a paid order at a tenth
of the price), then C1's egress, then the mail provider's quota through M2 and M3.

## 8. Item 5: retention and encryption

`node tools/security/review-uploads/retention-encryption.js retention` and `… encryption`.

**Sweeps that delete what is still needed.** H5: the CAD file behind a quote that can still be
ordered. I found no other case: an order's or open request's files survived ageing; a drawing
carried from a quote to an order is kept while either points at it; files the server cannot
decrypt after a key change are not deleted (file counts 6/1/1/2 before and after two restarts).

**Sweeps that do not delete what they should.**
- Attachments of declined, lost and expired requests, and drawings on cancelled orders: kept for
  ever (H4).
- An upload orphaned by a crash: 7 days (L2).
- The preview mesh and measurements of a part stay as long as any quote, request or order names
  the part, long after the "deleted after 7 days unless you order" line on the home page
  (`client/src/pages/LandingPage.jsx:44`) says the upload is gone. The mesh is the shape of the
  part. Either say so on the page or delete payload files with the upload.
- An orphan drawing (no row points at it) is removed after 24 hours: confirmed.

**Encryption, with a throwaway key.**

| Check | Result |
|---|---|
| Every file in the four folders ends in `.enc` | yes |
| Readable STEP, DXF, PDF, STL or mesh content in any file other than the database | none found |
| The database | file name, small DXF outlines and small meshes in the clear (M5) |
| Written in plain first | the upload itself, while it is read (up to 90 s); payload files are encrypted in memory before they touch the disk |
| Left in plain | an upload orphaned by a crash (L2); anything stored before the key was set |
| Key replaced, old key not listed | admin download 500 `wrong-key`; reopening a quote works without its preview; pricing a part whose detail is in a file 409 `part-data-unavailable`; changing DXF units 500; new uploads work; server stays up; nothing deleted |
| Old key listed in `NORD_FILE_ENC_KEY_PREVIOUS` | everything opens again |
| Key removed | old files 500 `no-key`; new files stored plain; the startup log says so |

The key-change behaviour matches the guide.

## 9. Claimed fixes: which I verified by attack

| Claim (report, item) | Verdict | How |
|---|---|---|
| Parsing in a worker pool with time and memory limits (server 2) | Holds | section 5 |
| Model ceilings, ZIP and XML bombs (server 3) | Holds | section 5 |
| A file that fails to parse is deleted; content checks for STL and IGES (server 4) | Holds | `files.js`: 8 mismatched files, 0 left |
| Upload folders and database bounded (server 5) | Bounded, but the bound is the outage (H3, H4) | `availability.js storage`, `db` |
| "Refused bytes count too" (server 3.2) | Partly false | L1 |
| A request over the route's maximum is refused before its body is read (server 3.2) | Holds | `claims.js`: 900 MB declared, 413 in 244 ms |
| IPv6 grouped by /64; forged `X-Forwarded-For` (server 7) | Holds locally | `availability.js keys` |
| Stored names are server-generated; no client string reaches a path (server 3.3) | Holds | `files.js`: 16 hostile names, traversal ids on the download route |
| Download helper: attachment, `application/octet-stream`, `nosniff`, encoded name (server 16, 17) | Holds | `files.js`: 8 polyglots and hostile names on three download routes |
| A replaced or removed quote drawing is deleted (server 3.3) | Holds | `files.js` |
| Drawing sweep removes orphans after 24 hours (server 3.4) | Holds | `retention-encryption.js` |
| Client disconnect cancels the parse and deletes the file (server 3.1) | Holds | `files.js`: same address uploads again in 112 ms |
| Encryption of all four folders; key change; previous key (server 17, integration) | Holds, with M5 and L2 | `retention-encryption.js encryption` |
| R1: a refused request no longer leaves its attachment (integration) | Holds | `files.js`: honeypot, missing token, bad email, cut-off upload |
| R2: attachments content-checked (integration) | Holds | `files.js`: HTML as `.pdf`, SVG as `.png` refused; polyglots with correct magic accepted and only ever served as downloads |
| O1: part geometry and mesh out of the database (integration 5) | Holds for parts (5.1 kB a cube); the database is still filled through quotes (H3) and through small DXFs (L6) | `claims.js`, `availability.js db` |

**Could not verify, and why.**
- How Railway's edge builds `X-Forwarded-For`, and whether it forwards chunked bodies: needs the
  live platform, which was out of bounds.
- The real Turnstile widget and Cloudflare's verifier: stubbed here.
- Behaviour on Node 20: this machine has Node 22.23 only. The parser limits are V8 and libuv
  features present in both.
- That no input can grow WebAssembly memory past the watchdog between two checks: I did not find
  one; that is not proof.

## 10. Open items in the two reports that I rate differently

| Item | Their rating | Mine | Why |
|---|---|---|---|
| "Reopening a quote reads each mesh on the main thread" (integration) | Low, "about 0.1 s per dense part" | Critical | C1: 478 MB answer, 16 s, process killed |
| O1, database growth (integration) | Fixed | High, open | H3: quotes were not part of the fix |
| O6, storage ceiling under abuse (server, integration) | Medium, "recovery is the owner declining spam requests" | High | H4: 106 seconds; declining a request frees no attachment; no delete action |
| "Verified-human token replayable for its hour" (integration) | Low | Medium | M1: it is what keeps Turnstile from slowing C2, H2, H3, H4 |
| O3, storing a large part pauses the main thread 0.3–0.5 s (server) | Low | Low, agreed | measured 403 ms worst |
| O2, feature recognition slow on dense meshes (server) | Medium (product) | High as an availability input | 100,000 random triangles: 31 s and 779 MB, then refused. It is what makes worker time cheap to burn (H2) |
| O4, `TRUST_PROXY_HOPS` (server) | Medium, verify | Agreed | plus I2 |
| "Throttles, budgets and the parse queue are in memory" (both) | Low | Low alone, but see C1 | an attacker can cause the restart |
| "Turnstile keys not set" (integration) | High until done | Agreed | and see M1: it will not be enough alone |

## 11. Where I found nothing

- **Path traversal, overwrite, cross-part read.** 16 hostile file names on the CAD route, 4 on the
  request form, encoded and upper-case ids on the download route, 15 URL forms for reaching
  `data/` or source files from the site's origin. Every stored name was a server-made UUID with an
  allow-listed extension; nothing was written outside its folder; nothing under `data/` is served.
  I read every place a path is built (`api.js`, `rfq.js`, `partPayloads.js`, `fileCrypto.js`).
- **Rendering an upload in a browser.** HTML, SVG and script polyglots behind PDF, PNG, JPEG, DXF
  and DWG magic bytes are stored, and all three download routes answer `application/octet-stream`,
  `attachment`, `nosniff`. No route serves a stored file inline.
- **Header injection through a file name.** CR/LF, quotes and a second `filename=` in the name: the
  upload is refused or the name is reduced; `Content-Disposition` is built by Express's encoder.
- **Leftovers.** Over-size, too many files, wrong field, bad extension among good ones, content
  mismatch, parse failure, timeout, busy, client hang-up mid-upload and mid-parse, request form
  refused after the file was written: 0 files left in every case. Only a process kill leaves one (L2).
- **ZIP tricks.** Section 5.
- **Crashing the process or leaking workers through a parser.** 59 inputs, 90 killed parses: none.
- **Negative or zero prices.** None.
- **Sweeps deleting an order's or an open request's files.** None beyond H5.

How hard I looked: about 1,650 lines of scripts, 59 hostile files across five formats, and
roughly an hour and a half of attack time against the local server. I did not fuzz OpenCascade at
the byte level, and I did not build a STEP that makes it allocate without bound; a determined
attacker with more time might.

## 12. Outside my area, noticed in passing

- `POST /api/orders/checkout-session` has no limit of its own: 198 Stripe sessions in a row for
  one order (section 7). For the payments reviewer.
- A quote may be saved under an id the client chooses (`server/routes/api.js:666`). I did not find
  a way to abuse it; for the authorisation reviewer.
- The server report's CORS note says authentication is a bearer token; sessions are now cookies.
  The document is out of date on that line.

## 13. How to re-run

```sh
cd tools/security/review-uploads
node files.js                              # file handling, 60 checks, about 1 minute
node parser-abuse.js --out /tmp/p.jsonl    # all 59 files, about 25 minutes
node report-table.js /tmp/p.jsonl          # the table in section 5
node price-nan.js                          # H1
node availability.js session               # C1 (uses over 2.6 GB of memory: run it alone)
node availability.js session 25 1          # C1, without the crash
node availability.js mainthread            # C2
node availability.js pool                  # H2, about 11 minutes
node availability.js queue                 # H2
node availability.js db 1600               # H3, about 13 minutes
node availability.js storage               # H4, writes about 2.5 GB to a temporary folder
node availability.js memory | creep 90 3000 | keys | budget | refused
node abuse-limits.js off ; node abuse-limits.js on
node retention-encryption.js retention ; node retention-encryption.js encryption
node claims.js
```

Run them with any proxy variables unset
(`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NO_PROXY=localhost,127.0.0.1`).
Each starts its own server on a free port with a throwaway data folder and removes it afterwards.
