# Go-live checklist

The boxes only. Every line is a step in [`go-live-runbook.md`](go-live-runbook.md), which says
where to click, what you should see, and what to do if you do not. **R** = required for launch.

## Before you start (these need waiting time)

- [ ] **R** Namecheap: screenshot the DNS records and note the Mail Settings choice
- [ ] **R** Resend: sending domain added, DNS records in Namecheap, status **Verified**
- [ ] **R** Resend: sending-only API key created and saved in the password manager
- [ ] **R** Incoming mail to the shop's address still arrives (test from outside)
- [ ] **R** Cloudflare: Turnstile widget created with all five hostnames; both keys saved
- [ ] Optional head start: new domain added in Railway and its records in Namecheap (12.1, 12.2)

## 1. Backup

- [ ] **R** Volume mount path reads `/app/data`
- [ ] **R** Manual backup `before-go-live` is in the list
- [ ] **R** Daily and Weekly backup schedules are on
- [ ] **R** Any material or finish you changed in Admin on the live site is written down (the first start replaces those lists with the new defaults; pricing rules are kept)

## 2. Variables (Railway → service → Variables)

- [ ] **R** `JWT_SECRET` (32+ characters)
- [ ] **R** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
- [ ] **R** `STRIPE_WEBHOOK_SECRET` is present and starts `whsec_` — **confirm before the merge: the site exits at startup without it**
- [ ] **R** `ADMIN_EMAIL` (the address of your existing admin account)
- [ ] **R** `FRONTEND_URL` = `https://nordmfg.com` (changes in step 12)
- [ ] **R** `EMAIL_API_KEY` — email is a launch requirement: without it no order, payment-problem, refund or dispute email reaches the shop
- [ ] **R** `EMAIL_FROM`
- [ ] **R** `RFQ_NOTIFY_TO`
- [ ] **R** `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` — **both, before the merge: the site exits at startup without them** (runbook, "Before you start", part B)
- [ ] **R** `NORD_FILE_ENC_KEY` — saved in the password manager **first**
- [ ] `TRUST_PROXY_HOPS` left unset
- [ ] **R** None of these exist: `RAILWAY_RUN_UID`, `SE_TEST_HOOKS`, `EMAIL_OUTBOX_DIR`, `CSP_REPORT_ONLY`, `ADMIN_RECOVERY`, `ADMIN_SETUP_CODE`, `ALLOW_LAUNCH_WITHOUT_BOT_CHECK`, `NIXPACKS_*`
- [ ] **R** Stripe webhook endpoint exists; its signing secret is the one entered above
- [ ] **R** Stripe webhook event types enabled, all six: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `refund.updated`, `charge.dispute.created`, `charge.dispute.closed`
- [ ] No promotion codes created in Stripe (`STRIPE_PROMOTION_CODES` stays off until you decide)
- [ ] `CHECKOUT_SESSION_MINUTES` left unset (a payment page stays open two hours)
- [ ] Stripe: card is the only payment method on; refund receipts and dispute emails set as you want them

## 3. Railway build settings (Settings)

- [ ] **R** Branch `master`; root directory empty
- [ ] **R** Builder **Dockerfile**; path `Dockerfile`; build command empty; watch paths empty
- [ ] **R** Start command **empty**; pre-deploy command empty
- [ ] **R** Healthcheck path `/api/health`; timeout `300`
- [ ] **R** Restart policy On Failure, `100`
- [ ] **R** Service memory limit set to 2 GB (recommended)
- [ ] **R** `MEMORY_BUDGET_MB` = the service's memory limit in MB (`2048` for 2 GB; leave unset only if the service has 1 GB)
- [ ] **R** Draining time `15` seconds
- [ ] Railway config file path empty; replicas 1

## 4–5. Merge

- [ ] **R** Everything above is ticked
- [ ] **R** Pull request merged
- [ ] **R** Build log: `Using detected Dockerfile!` and `22/22 routes rendered`
- [ ] **R** Deploy log: no `FATAL`, no `WARNING` block, no `ALERT`, no "running as root"
- [ ] **R** Deploy log: `Admin account …: present.`
- [ ] **R** Deploy log: `Memory budget: 2048 MB …` (the figure is the service's memory limit)
- [ ] Deploy log, first start only: an `Order sweep:` line — old unpaid card orders checked with Stripe and closed; they read "Not paid, closed" in Admin (expected)
- [ ] **R** `https://nordmfg.com/api/health` shows `"status":"ok"`

## 6. Sign-in

- [ ] **R** Signed in with the existing account
- [ ] **R** Two-step sign-in enrolled; ten recovery codes saved (not on the phone)
- [ ] **R** "Two-step sign-in is on" email arrived

## 7–9. Checks

- [ ] **R** Admin → Pricing → Shop: Mill, Lathe and Router rate `110` $/h; margin `50` %
- [ ] Known for later: after any price change, Admin → Change log → **End price hold on open quotes** if earlier quotes should not be bought at the old price
- [ ] **R** Cloudflare box visible on `/register` and `/rfq` (private window)
- [ ] **R** Admin → System: no red banner; every protection **on** except Canonical host; Card payments shows promotion codes **off** and 120 minutes
- [ ] **R** "Send a test email": email check arrived in the shop inbox (not spam)
- [ ] "Send the digest now": digest arrived
- [ ] **R** "Download full backup": file saved outside Railway
- [ ] **R** Admin → System → Storage: **Database** is under half of its ceiling (if not: `DB_MAX_MB`, runbook step 9)

## 10. Real order

- [ ] **R** Quote → new account → confirm email → pay with a real card
- [ ] **R** Order page shows paid; buyer confirmation arrived; **one** "New order" email in the shop inbox
- [ ] **R** Stripe → Webhooks → Event deliveries: `checkout.session.completed` **200**
- [ ] **R** Admin → Orders → the part file downloads and opens
- [ ] **R** Refunded in Stripe; the order shows **Refunded** and has left the production queue; one refund notice in the shop inbox

## 12. Domain cutover

- [ ] `straightedgemfg.com` and `www.straightedgemfg.com` added in Railway
- [ ] Namecheap: parking and redirect records removed; ALIAS `@`, CNAME `www`, both TXT records added
- [ ] Both names have a green tick in Railway; both `/api/health` addresses open with a padlock
- [ ] Incoming mail still arrives
- [ ] `CANONICAL_HOST`, `REDIRECT_HOSTS` set; `FRONTEND_URL` changed; deployed
- [ ] Deploy log `[hosts]` line names the canonical host and the three redirecting hosts
- [ ] `www` and both `nordmfg.com` names land on the same page of `straightedgemfg.com`
- [ ] Signed in again on the new address; Cloudflare box visible there
- [ ] Stripe endpoint address changed to the new domain; a delivery shows **200**
- [ ] `www.nordmfg.com` is attached in Railway

## 13. Search, monitor, network

- [ ] Search Console: domain property verified; sitemap submitted
- [ ] Search Console: change of address from `nordmfg.com` (if it was ever registered there)
- [ ] UptimeRobot monitor on `https://straightedgemfg.com/api/health` shows Up; alert tested
- [ ] Two networks get separate `RateLimit-Remaining` counts

## 14. By 2026-12-01

- [ ] Step 3 settings re-checked before the date
- [ ] Redeployed on or after 12-01; logs match step 5; any newly editable field filled in
- [ ] Calendar note: move from Node 20 to Node 22 in the first month

## If there is ever no admin account (fresh volume) or you are locked out

- [ ] Runbook step 6's table: `ADMIN_SETUP_CODE` (a code you invent, 20+ characters) → `/admin/setup` → two-step enrolment → delete the variable
- [ ] Locked out with no mailbox: `ADMIN_RECOVERY=setup-code` with a **new** `ADMIN_SETUP_CODE`; lost phone and codes only: `ADMIN_RECOVERY=reset-2fa`. Remove both after use

## First week

- [ ] Daily digest arrives each morning
- [ ] Day 2: a Daily backup is listed in Railway
- [ ] Stripe event deliveries: none failed
- [ ] Digest: no "needs a look" beside any order state; if there is, Admin → Orders, deal with it in Stripe, clear the flag with a note
- [ ] Resend: nothing bounced
- [ ] Second full backup downloaded
- [ ] Spam requests declined in Admin → RFQs
