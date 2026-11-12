# Deploy notes — 2026-11-11

Branch `deploy-runbook`, cut from `hardening-2026-11-11` (e4881d3). Not pushed, not merged.
For the owner's step-by-step, read [`go-live-runbook.md`](go-live-runbook.md); the one-page
version is [`owner-checklist.md`](owner-checklist.md). This file is the record behind them: what was
checked in each vendor's own documentation and when, what could not be checked, what was built and
how it was tested, and what has to be clicked in each dashboard.

Nothing here changes pricing, public copy or a security check. No account was opened and no
setting was changed at Railway, Namecheap, Stripe, Resend or Cloudflare. No secret, key, token or
real address is in any file of this branch; tests make throwaway values when they run.

## 1. What was verified in vendor documentation

Every page below was read on **2026-11-11**. Quotes are the vendor's words.

### Railway

| Question | What the documentation says | Page |
|---|---|---|
| What happens to `railway.toml` on 2026-12-01? | "Config as Code is deprecated." "Existing `railway.json` / `railway.toml` files continue to work for services that already use them until 2026-12-01 (hard cutoff)." "New services cannot opt into Config as Code." | <https://docs.railway.com/config-as-code> |
| | "Existing Config as Code files stop being read on 2026-12-01 (hard cutoff)." | <https://docs.railway.com/infrastructure-as-code> |
| Until then, which wins, the file or the dashboard? | "Configuration defined in code will always override values from the dashboard." "The settings in the dashboard will not be updated with the settings defined in code." | <https://docs.railway.com/reference/config-as-code> |
| What replaces it? | "Infrastructure as Code is the replacement": one file, `.railway/railway.ts`, applied with the Railway CLI (`railway config plan` / `apply`); "Railway doesn't read" that folder during deploys. For a one-person shop the practical replacement is the dashboard: every setting the old file carried has a field in the service's Settings. | <https://docs.railway.com/infrastructure-as-code> |
| Which builders exist? | `build.builder`: `RAILPACK` (default) or `DOCKERFILE`. Nixpacks is not listed, and no page of the current documentation mentions it. | <https://docs.railway.com/reference/config-as-code> |
| How is a Dockerfile picked up? | "When building a service, Railway will look for and use a `Dockerfile` at the root of the source directory." The file "must be named `Dockerfile` with a capital D". The build log then says "Using detected Dockerfile!" A different path: the variable `RAILWAY_DOCKERFILE_PATH`. | <https://docs.railway.com/builds/dockerfiles> |
| What starts the container? | The start command "defaults to the `ENTRYPOINT` and / or `CMD` defined in the Dockerfile." | <https://docs.railway.com/builds/build-and-start-commands> |
| Health check | "The default timeout on healthchecks is 300 seconds (5 minutes)." "Railway uses the hostname `healthcheck.railway.app` when performing healthchecks." "The healthcheck endpoint is currently ***not used for continuous monitoring***… it is only called at the start of the deployment." | <https://docs.railway.com/deployments/healthchecks> |
| Deploys with a volume | "To prevent data corruption, we prevent multiple deployments from being active and mounted to the same service. This means that there will be a small amount of downtime when re-deploying a service that has a volume attached, even if there is a healthcheck endpoint configured." | same page |
| Restart policy | "The default is `On Failure` with a maximum of 10 restarts." | <https://docs.railway.com/deployments/restart-policy> |
| Stopping | The previous deployment "is sent a SIGTERM signal and given time to gracefully shutdown" before SIGKILL; the time is set in the Settings pane or with `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, "the SIGTERM to SIGKILL buffer time (in seconds), its default value is 0." | <https://docs.railway.com/deployments/deployment-teardown>, <https://docs.railway.com/variables/reference> |
| Volume ownership | "Volumes are mounted as the `root` user. If you run an image that uses a non-root user, you should set the following variable on your service: `RAILWAY_RUN_UID=0`" — "The UID of the user which should run the main process inside the container. Set to `0` to explicitly run as root." | <https://docs.railway.com/volumes>, <https://docs.railway.com/variables/reference> |
| When is the volume there? | "Volumes are mounted to your service's container when it is started, not during build time." "Volumes are not mounted during pre-deploy time." Railway's builder puts the app in `/app`, so a program writing `./data` mounts at `/app/data`. | <https://docs.railway.com/volumes> |
| Volume size | "Pro plan: 50GB"; "Pro users and above can self-serve to increase their volume up to 1 TB." | <https://docs.railway.com/volumes/reference> |
| Volume backups | Schedules: "Daily – Backed up every 24 hours, kept for 6 days", "Weekly – Backed up every 7 days, kept for 27 days", "Monthly – Backed up every 30 days, kept for 89 days"; set in "the service settings panel, under the Backups tab"; several may be selected. Restore: find the backup, press `Restore`; a new volume is mounted at the same path, the change is staged, press `Deploy`. "Backups can only be restored into the same project + environment." "Wiping a volume deletes all backups." "Manual backups are limited to 50% of the volume's total size." "Backups are incremental and Copy-on-Write, we only charge for the data exclusive to them." | <https://docs.railway.com/volumes/backups> |
| Custom domains | Settings → Public Networking → `+ Custom Domain`; Railway gives "a `CNAME` record (e.g., `g05ns7.up.railway.app`) and a `TXT` record used to verify domain ownership. Both records are required." "If the `TXT` record is missing, requests to your custom domain will return a `404` error." Certificates: "should happen within an hour of your DNS being updated"; DNS "may take up to 72 hours". | <https://docs.railway.com/networking/domains/working-with-domains> |
| Bare (apex) domain | "Railway supports CNAME Flattening and dynamic ALIAS records." Providers listed as working: Cloudflare (CNAME), DNSimple (ALIAS), **Namecheap (CNAME)**, bunny.net (ANAME). Workaround for others: move the nameservers to Cloudflare. | same page |
| Domain limits | Hobby "is limited to 2 custom domains per service"; Pro "20 domains per service by default". Four are needed here (two names × with and without www). | same page |
| Variables Railway provides | `RAILWAY_PUBLIC_DOMAIN` ("the public service or customer domain"), `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, `RAILWAY_DEPLOYMENT_ID`, `RAILWAY_VOLUME_MOUNT_PATH`. | <https://docs.railway.com/variables/reference> |
| Shell on the service | `railway ssh [-- command]`; SCP and SFTP are supported. | <https://docs.railway.com/cli/ssh> |

**The Nixpacks notice.** The owner saw "the Nixpacks builder is deprecated" in the settings page.
The current documentation does not say that sentence anywhere: it no longer mentions Nixpacks at
all, lists only `RAILPACK` and `DOCKERFILE` as builders, and says "Railway uses Railpack to build
your code". The only statements found are on Railway's community forum: a Railway employee wrote
(about a year ago) that Nixpacks "will eventually be fully removed" but "will be around for far
more than a few months"
(<https://station.railway.com/questions/will-nixpacks-ever-be-fully-removed-f7984525>), and an
automated reply states "The only valid builder values today are `RAILPACK` (default) and
`DOCKERFILE`" (<https://station.railway.com/questions/about-nixpacks-builder-d515d570>). So: the
deprecation is consistent with everything published, **no removal date for Nixpacks is published**,
and the date that is published and firm is the config-file cutoff. This branch removes the
dependency on both.

**Not confirmed by Railway's documentation** (stated there as unknown, not guessed here):

- Whether a *custom start command* entered in the dashboard replaces the image's `ENTRYPOINT`, its
  `CMD`, or both. The runbook therefore says: leave it empty.
- What Railway does when a new deployment of a volume-backed service fails its health check — in
  particular whether the previous deployment is started again by itself.
- Whether backups are included on every paid plan (the page points to the pricing page).
- The exact name of the TXT record Railway shows for a custom domain: the runbook says to copy
  whatever the dashboard shows.
- Whether `railway.toml` naming a builder that no longer exists (`NIXPACKS`, as on `master`) falls
  back or fails. A forum thread reports the root Dockerfile being used regardless
  (<https://station.railway.com/questions/config-as-code-iac-migration-railway-bab3852f>, no staff
  answer). This branch changes the file to `DOCKERFILE`, so the question does not arise after merge.

### Namecheap

- An ALIAS record exists and may be used at the root: "An ALIAS record can also be used if you wish
  to alias the root domain to another service"; Host `@`; "only 1 min or 5 min are available" for
  TTL; available "on domains that are using our BasicDNS, FreeDNS or PremiumDNS"; CNAME, URL
  Redirect, A and AAAA records on the same host "can conflict… we recommend removing them".
  <https://www.namecheap.com/support/knowledgebase/article.aspx/10128/2237/how-to-create-an-alias-record/>
- Railway lists Namecheap as working with a **CNAME** at the root; Namecheap's own article
  describes **ALIAS**, and says of it: "The important difference is that ALIAS can coexist with
  other records on that name." The bare domain here also carries mail records (MX, SPF, DMARC),
  which an ordinary CNAME on the same name cannot coexist with. The runbook therefore uses
  **ALIAS** for `@` first, a CNAME second (with a mail test straight after), and Cloudflare
  nameservers third. Whether Namecheap's root CNAME is flattened in a way that leaves mail
  records working, and whether Railway verifies a Namecheap ALIAS, were **not tested** (no change
  was made to the domain): the two vendors' pages do not settle it.

### Resend

- A sending domain needs DKIM and SPF records ("`TXT` and `MX` or `CNAME` records"); "We strongly
  recommend sending emails from a subdomain"; verification "will often" complete "within 15 minutes"
  and "can occasionally take up to 72 hours". <https://resend.com/docs/add-a-domain>,
  <https://resend.com/docs/dashboard/domains/introduction>
- At Namecheap (Resend's own guide): the SPF MX record is entered under **Mail Settings → Custom
  MX**, host `send` (or `send.<subdomain>`), value as shown by Resend (for example
  `feedback-smtp.us-east-1.amazonses.com`), priority 10; a TXT record on the same host with
  `v=spf1 include:amazonses.com ~all`; a TXT record `resend._domainkey` (or
  `resend._domainkey.<subdomain>`) with the value Resend shows. Warning in the guide: switching
  Mail Settings to Custom MX from another setting stops that setting's mail unless its MX records
  are re-entered. <https://resend.com/docs/knowledge-base/namecheap>
- DMARC is optional and comes after verification; starter record: TXT `_dmarc`, value
  `v=DMARC1; p=none; rua=mailto:<a mailbox you read>;` then `quarantine`, then `reject`.
  <https://resend.com/docs/dashboard/domains/dmarc>
- Errors the email check interprets: 401 `restricted_api_key` (a sending-only key used for
  anything else), 403 `validation_error` (domain not verified; or test emails only to your own
  address), 429 `rate_limit_exceeded` / `daily_quota_exceeded` / `monthly_quota_exceeded`.
  <https://resend.com/docs/api-reference/errors>
- **Not verified:** the exact record values for this domain (Resend generates them per domain and
  region), and the response shape of `GET /domains` beyond what the error page implies — the
  check treats anything unexpected as "skip", never as a pass.

### Stripe

- "We consider redirect responses to webhook requests as failures." Automatic retries "for up to
  three days with an exponential back off in live mode"; a failed event can be resent by hand from
  the Dashboard "for up to 15 days". "Stripe generates a unique secret key for each endpoint."
  <https://docs.stripe.com/webhooks>
- An existing endpoint's address can be changed: "You may edit the `url`, the list of
  `enabled_events`, and the status of your endpoint." The update call takes no secret and returns
  none, so the signing secret is unchanged. <https://docs.stripe.com/api/webhook_endpoints/update>
- **Not verified:** the wording of the buttons in today's Stripe Workbench (the runbook describes
  what to look for), and which address the live endpoint points at now.

### Uptime monitor

- UptimeRobot's free plan: "genuinely free, and it is available for any use, including commercial
  and business use"; 50 monitors, 5-minute checks (their help article, dated 2026-09-28).
  <https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan>
- Better Stack's free plan (10 monitors, 3-minute checks, email alerts) is described by third
  parties as "free for personal projects"; not chosen for that reason.
  <https://www.productcompass.pm/p/free-uptime-monitoring> (updated 2026-11-08)

### Node

- Node 20 left security support on **2026-04-30**; its last release is 20.20.2 (2026-03-24).
  Node 22 is supported to 2027-04-30, Node 24 to 2028-04-30. <https://endoflife.date/node>
- The site's suites are documented as run on 20.20.2 and on 22. The image pins 20.20.2 because
  that is "the production runtime" everything was tested against; see decision D3.

## 2. What could not be verified here, and why

| Item | Why | What to do |
|---|---|---|
| The Docker image itself was **not built** | The sandbox has a Docker client but no running daemon, and the proxy refuses `registry-1.docker.io` and `hub.docker.com` (policy), so the base image cannot be pulled | Each stage's commands were run by hand in clean folders under Node 20 (section 4). Railway's first build is the first real build: watch its log (runbook step 5) |
| That the tag `node:20.20.2-bookworm-slim` exists, and its digest | Same: Docker Hub is not reachable from here | If the build log says the image is not found, change the `FROM` line to `node:20-bookworm-slim` and redeploy. To pin a digest later: `docker buildx imagetools inspect node:20.20.2-bookworm-slim` |
| Node 20.20.2 exactly | The sandbox has 20.20.0 and 22.23.4 | Suites run on both of those |
| Railway behaviour: start-up as root, `chown` of the mounted volume, SIGTERM delivery, draining time | Needs a real deployment | The entrypoint and the shutdown handler are tested locally as root with a root-owned folder; runbook step 5 lists the log lines that prove each on Railway |
| That the volume is mounted at `/app/data` | Dashboard only | Runbook step 1 |
| Namecheap: CNAME or ALIAS at `@` | No DNS change was made | Runbook step 12 has the order to try them in |
| Resend, Stripe, Cloudflare, Railway dashboards as they look today | No account access by design | The runbook names what to look for, not pixel positions |
| The real Turnstile widget under the page policy | Carried over from the hardening report: the sandbox cannot load Cloudflare's script | Runbook step 8 |
| An email actually arriving | No key | `npm run email:check` / the admin button, runbook step 10 |
| `TRUST_PROXY_HOPS` on the live site | Needs the live edge | Runbook step 13 |

## 3. Findings

1. **A stop could land inside a database save.** `server/models/database.js` writes the whole
   database to `quoting.db.tmp` and renames it — synchronously, on every write. There was no
   SIGTERM handler. A test that kills a process doing back-to-back saves of a 12 MB database found
   a half-written `quoting.db.tmp` left behind in 1 of 6 kills. The rename means the previous file
   is intact (so no corruption), but the request in progress is cut and its write lost. As process
   1 in a container, a Node process with no handler ignores SIGTERM altogether and is killed hard
   at the end of the draining time. Fixed by `server/ops/shutdown.js`. `database.js` itself was
   not edited.
2. **Railway's draining time defaults to 0 seconds.** With 0 there is no time to finish a request
   between SIGTERM and SIGKILL. The config file and the runbook set 15.
3. **The save is not flushed to disk** (`writeFileSync` then `rename`, no `fsync`). A process kill
   cannot hurt it; a host crash or power loss at the wrong moment could leave an empty or short
   file. The shutdown handler flushes on a clean stop. Flushing on every save is a one-line change
   in `server/models/database.js` (open, write, `fsync`, close) and belongs to that file's owner;
   it was left alone because it changes the cost of every write. Volume backups cover the rest.
4. **`npm test` is 40/41 on a fresh checkout.** `server/routes/botCheck.test.js` reads
   `data/rfq-drawings` in the repository folder, which exists only after something has created
   it. With that folder present: 41/41. Not changed here (the file is in another engineer's area);
   one `mkdirSync` in the test fixes it.
5. **`server/services/pricingPreview.js` reads `tools/vet-quotes/parts` at run time** (the six
   reference parts in the pricing console). The image copies that folder for this reason.
6. **HSTS was sent on every host** with `includeSubDomains; preload`. Sending it from
   `nordmfg.com` would pin that domain and all its subdomains to HTTPS for a year in every
   visitor's browser, whatever happens to the domain later. With `CANONICAL_HOST` set, the header
   now goes out on the canonical host only until `HSTS_ALL_HOSTS=true`. On the canonical host it
   is unchanged (the header is `security/headers.js`'s). Note `includeSubDomains` there: any
   future subdomain of `straightedgemfg.com` that people open in a browser must serve HTTPS.
7. **`server/seo.js` already redirects `www.straightedgemfg.com` to the bare domain**, and the
   pages, sitemap and canonical tags are built for the bare domain. The canonical host is
   therefore the bare domain; `CANONICAL_HOST=www.…` is refused at startup (it would loop).
   Reported separately by the reviewer: `normalize` and the trailing-slash redirect in `seo.js`
   can produce a protocol-relative Location. Not touched here (branch `review-fixes` owns it); the
   redirects added here strip any leading run of `/`, `\`, `%2f`, `%5c` so they cannot feed it.
8. **Node 20 is past end of life** (section 1). Decision D3.
9. **The database download no longer contains the customer files or previews** (hardening
   report). The new full backup does; the tested restore drill is section 4.

## 4. What was built, and how it was tested

| Item | Files | Tests |
|---|---|---|
| Dockerfile build, entrypoint, ignore file | `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `railway.toml` | `server/ops/entrypoint.test.js` (6); stages reproduced by hand, below |
| Clean stop | `server/ops/shutdown.js` | `server/ops/shutdown.test.js` (7) |
| Canonical host, redirects, no-index, HSTS scope | `server/ops/canonicalHost.js` | `server/ops/canonicalHost.test.js` (8) |
| Counters, alerts, checks, digest, status | `server/ops/{events,observer,alerts,checks,digest,status,state,opsEmails,index}.js` | `server/ops/ops.test.js` (10) |
| Owner notifications (audit; already existed) | — | `server/ops/ownerNotifications.test.js` (5) |
| Admin routes, full backup, restore | `server/ops/{routes,backupArchive}.js`, `scripts/ops/{backup,restore}.js` | `server/ops/system.test.js` (5) |
| Email check | `server/ops/emailCheck.js`, `scripts/ops/email-check.js` | `server/ops/emailCheck.test.js` (7) |
| Admin → System tab | `client/src/components/admin/SystemTab.jsx`, 5 lines in `AdminPanel.jsx`, 4 in `utils/api.js` | Opened in Chromium against a production-mode server: 0 console errors, 0 policy violations; screenshot `screens/admin-system-tab-1360.png` |

Edits to shared files: `server/index.js` (three one-line mounts, one `const server =`),
`package.json` (three script lines), `.env.example` (appended block), `railway.toml` (rewritten;
it is this branch's file), the two client files above.

**Suites.** See the report for the final counts on Node 22 and Node 20.

**The image, reproduced by hand** (Node 20.20.0; the image was not built):

1. *Context.* `git archive HEAD`, then `.dockerignore` applied with Docker's matching rules:
   448 files kept, 274 left out; no `data/`, no `.env`, no tests, no docs.
2. *prod-deps.* `npm ci --omit=dev --ignore-scripts` on the two package files alone: 199
   packages, both `.wasm` files present, no `vite`, no `concurrently`.
3. *build.* Client `npm ci --include=dev`; `node scripts/seo/gen-catalog.js`; `npm run build`
   with `NODE_ENV=production`: 22/22 routes prerendered, sitemap of 22 URLs. No git in this stage,
   so every `lastmod` is the build date (the prerender's own fallback).
4. *runtime.* Production modules, `server/`, `shared/`, `scripts/ops/`, the reference parts and
   `client/dist`: 128 MB. Every `RUN test …` line passes. Started through the entrypoint as root
   on a root-owned, empty `data/`: the folder is handed to the unprivileged user, the server runs
   as that user with no capabilities, `/api/health` answers, a prerendered page is served, an old
   host redirects, a STEP file is parsed in the worker through the WebAssembly reader, an STL gets
   its preview file, the image's `HEALTHCHECK` command exits 0, and SIGTERM produces
   "database saved and flushed to disk" and exit 0.

**Restore drill** (`system.test.js`, production mode, file encryption on): an owner with two-step
sign-in, a buyer, an uploaded part with a 3D preview, a quote, a request with an attached drawing,
a firm quote accepted on a purchase order → full backup downloaded → archive checked (only the
five known paths, every checksum matches, no key in it, the CAD file's and drawing's bytes not
readable in it) → server stopped, data folder emptied → `scripts/ops/restore.js` → server started
with the same `JWT_SECRET` and `NORD_FILE_ENC_KEY` → the owner signs in with the same password
and authenticator; the order (total, PO number, status), the quote and its preview (same
vertices), the same price on re-pricing, the request, the emailed firm-quote link, and the CAD
file and drawing (byte-identical after decryption) are all back. Twelve hostile archives (path
traversal, absolute path, link, unknown folder, checksum mismatch, duplicate, no manifest, cut
short) are refused with nothing written.

## 5. What resets on a restart, and what does not

In memory, reset by every deploy, restart or crash: all counters on Admin → System ("since the
last restart"), the list of recent events and raised alerts, and — as before this branch — rate
limits, upload budgets, sign-in failure counts and the parse queue.

On the volume (`data/ops/state.json`), kept: when each alert was last emailed and the last 24
hours of alert emails (so the cooldown and the daily cap hold across a crash loop), the day the
digest last went out, how the previous run ended, when a full backup was last downloaded.

Read fresh every time: orders, requests, quotes, storage and database sizes.

## 6. What has to be clicked, by dashboard

The runbook has these in order with what to expect; this is the list.

**Railway** (project "pleasing-celebration", the one service)

| Where | Setting | Value |
|---|---|---|
| Settings → Build | Builder | Dockerfile |
| Settings → Build | Dockerfile path | `Dockerfile` |
| Settings → Build | Custom build command | empty |
| Settings → Build | Watch paths | empty |
| Settings → Source | Branch | `master` |
| Settings → Source | Root directory | empty (`/`) |
| Settings → Deploy | Custom start command | **empty** |
| Settings → Deploy | Pre-deploy command | empty |
| Settings → Deploy | Healthcheck path | `/api/health` |
| Settings → Deploy | Healthcheck timeout | `300` |
| Settings → Deploy | Restart policy | On Failure, max retries `10` |
| Settings → Deploy | Draining time (graceful shutdown) | `15` seconds |
| Settings → Deploy | Replicas | 1 |
| Settings → Config-as-code / Railway Config File | path | empty |
| The volume | Mount path | `/app/data` |
| Service → Backups | Schedules | Daily and Weekly |
| Variables | must **not** exist | `RAILWAY_RUN_UID`, `SE_TEST_HOOKS`, `EMAIL_OUTBOX_DIR`, `CSP_REPORT_ONLY`, `ADMIN_RECOVERY`, `NIXPACKS_*` |
| Variables | required for launch | `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_EMAIL`, `FRONTEND_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`, `RFQ_NOTIFY_TO`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `NORD_FILE_ENC_KEY`, `TRUST_PROXY_HOPS` |
| Variables | at domain cutover | `CANONICAL_HOST`, `REDIRECT_HOSTS`; later `HSTS_ALL_HOSTS` |
| Settings → Networking | Custom domains | the bare domain and `www` of both names (four) |

**Namecheap** — the web records Railway shows for `straightedgemfg.com` and `www`; the mail
records Resend shows; one DMARC record. Later the same web records for `nordmfg.com`.

**Stripe** — the webhook endpoint's address; its event types; a live test order and refund.

**Resend** — add and verify the sending domain; one sending-only API key.

**Cloudflare** — one Turnstile widget with all the hostnames.

**Google Search Console** — add the property, submit the sitemap, later "Change of address".

**UptimeRobot** — one monitor on the health address.

## 7. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Sending address: on the main domain, or on a subdomain as Resend recommends | A subdomain for sending, with replies going to the shop's real mailbox (runbook step 9 explains the trade) |
| D2 | Keep `nordmfg.com` pointed at the site, and for how long | At least a year: old links, bookmarks and search results keep working |
| D3 | Node 20 (tested, out of support since April) or Node 22 (supported to April 2027; suites also pass on it) | Launch on 20 as tested; move to 22 in the first month — a one-line change in the Dockerfile, then the suites and one deploy |
| D4 | Flush every database save to disk (finding 3) | Yes, after launch, by whoever owns `server/models` |
| D5 | Digest hour (default 7 am Central) and whether to keep the daily email once things are quiet | Keep it through the first month |
| D6 | Where the off-site copy of the full backup lives | A password manager's file storage or an encrypted drive; it holds customer data |
| D7 | When to set `HSTS_ALL_HOSTS=true` | Not before D2 is settled |
| D8 | UptimeRobot (free) as the outside monitor | Yes |
