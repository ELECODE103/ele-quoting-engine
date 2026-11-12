# Go-live runbook

For the owner, to follow from top to bottom. Each step says where to click, what to enter, what
you should see, and what to do if you do not see it. The one-page version with just the boxes is
[`owner-checklist.md`](owner-checklist.md). Why each step is the way it is, with links to each
vendor's documentation, is in [`deploy-notes-2026-11-11.md`](deploy-notes-2026-11-11.md).

**Three rules for the whole document**

1. **You create and enter every secret yourself.** This document names variables; it never gives
   a value, and nobody else should generate, see or be sent one. Keep each in your password
   manager.
2. **Do the steps in order.** They are arranged so that the risky ones come after a backup and so
   that nothing is public before it is protected.
3. **If a "you should see" does not happen, stop there.** Each step says what to do. Do not go on
   to the next step hoping it sorts itself out.

The site is offline on purpose. It stays offline until step 5, which is the moment it comes back.

**What you need open:** Railway (project "pleasing-celebration"), Namecheap, Stripe, Resend,
Cloudflare, GitHub, your password manager, and the phone with your authenticator app.

**Dashboards change.** Names of buttons below are as the vendors' documentation gave them on
2026-11-11. If a button has moved, look for the same words nearby; the setting names are stable.

---

## Before you start: two things that need waiting time

Start these first. Both can sit and finish while you do steps 1 to 3.

### A. The sending domain in Resend (needed for step 2)

Email is **required for launch**. Without it, new accounts cannot be confirmed (so checkout is
not held back for unconfirmed addresses), you get no email about orders, requests, payment
problems or refunds, and no alerts.

**Decide the sending address first** (decision D1 in the deploy notes):

- *Recommended:* send from a subdomain, for example `mail.straightedgemfg.com`. Customers see
  mail from an address at that subdomain (for instance the name `quotes` at
  `mail.straightedgemfg.com`); when they press Reply it goes to your real mailbox
  (the site sets the reply address to `RFQ_NOTIFY_TO`). The website's sending reputation is kept
  apart from your own mailbox's. This is what Resend recommends.
- *Alternative:* verify the main domain and send from the shop's own address on it. It
  looks tidier; it shares reputation with your everyday mail.

**Check what mail the domain already has — do not skip this.** In Namecheap → Domain List →
**Manage** next to `straightedgemfg.com` → **Advanced DNS**:

1. Take a screenshot of the whole Host Records list and of the **Mail Settings** section. This is
   your way back.
2. Write down what the Mail Settings drop-down says: *Email Forwarding*, *Private Email*,
   *Custom MX*, *Gmail*, or *No Email Service*.
3. Note any record whose Host is `@` and Type is MX or TXT (a TXT starting `v=spf1` is your
   current SPF), and any record whose Host is `_dmarc`.
4. Ask yourself where mail to the shop's address actually arrives today (a Google or Microsoft
   mailbox, Namecheap Private Email, a forward to a personal address). If you cannot say, send
   yourself a test from another account before changing anything, and find where it lands.

Why it matters: one of Resend's records is an MX record, and Namecheap only lets you add MX
records when Mail Settings is **Custom MX**. Resend's own Namecheap guide warns that switching to
Custom MX from another choice turns that choice's mail off unless its MX records are entered by
hand. So:

- If Mail Settings is already **Custom MX**: you only add records. Nothing existing changes.
- If it is **No Email Service**: switch to Custom MX and add records. Nothing to lose.
- If it is **Email Forwarding**, **Private Email** or **Gmail**: **stop.** Before switching, get
  the MX records (and SPF line) for that service from Namecheap's help pages or their chat, so you
  can enter them under Custom MX in the same sitting. Switch only when you have them in hand, then
  send yourself a test from outside to prove incoming mail still arrives.

**Then, in Resend:**

1. Resend → **Domains** → **Add Domain**. Enter the sending domain you decided on. Pick the region
   nearest your customers (US East).
2. Resend shows the records to add. In Namecheap → Advanced DNS add each one exactly as shown.
   For a subdomain `mail`, they will look like this (the *values* are Resend's — copy them from
   Resend, not from here):

   | Where in Namecheap | Type | Host | Value | Notes |
   |---|---|---|---|---|
   | Mail Settings → Custom MX | MX | `send.mail` | the `feedback-smtp.…amazonses.com` name Resend shows | Priority 10 |
   | Host Records → Add New Record | TXT | `send.mail` | the `v=spf1 include:amazonses.com ~all` line Resend shows | |
   | Host Records → Add New Record | TXT | `resend._domainkey.mail` | the long value starting `p=` | paste it whole |

   Namecheap adds the domain to the Host by itself: type `send.mail`, not
   `send.mail.straightedgemfg.com`. (If you chose the main domain instead of a subdomain, the
   hosts are `send` and `resend._domainkey`.) Leave Resend's "Receiving" switch off.
3. Add one DMARC record if step 3 above found none: Type TXT, Host `_dmarc`, Value
   `v=DMARC1; p=none; rua=mailto:` followed by a mailbox you read, then `;`. If a `_dmarc` record
   already exists, leave it alone — a domain may have only one.
4. **Save All Changes** in Namecheap, then **Verify DNS Records** in Resend.

*You should see:* the domain's status in Resend change to **Verified**, usually within 15
minutes, occasionally up to 72 hours.
*If it has not verified after a few hours:* compare each record character by character with
Resend; the usual mistakes are the domain typed twice in Host, and a DKIM value cut short. Resend
has a **Restart verification** button.

5. Once verified: Resend → **API Keys** → **Create API Key**. Name it `straightedge-site`,
   permission **Sending access**, domain: the one you just verified. Copy the key straight into
   your password manager. You enter it in Railway in step 2.

### B. The Turnstile widget in Cloudflare (needed for step 2)

**The site will not start without the two keys this gives you.** From this release they are
required in the same way as the Stripe keys: if either is missing from Railway's Variables when
step 5 deploys, the deployment fails with a line naming the missing one, and the site stays
offline until it is added. So do this part before anything else, and enter both keys in step 2.

1. Cloudflare dashboard → **Turnstile** → **Add widget**. Name: `Straightedge`.
2. Hostnames: add `straightedgemfg.com`, `www.straightedgemfg.com`, `nordmfg.com`,
   `www.nordmfg.com`, and the Railway host — the name ending `.up.railway.app` shown in Railway →
   the service → Settings → Networking.
3. Widget mode: **Managed**. Create.
4. Copy the **Site Key** and the **Secret Key** into your password manager.

### C. Optional head start: the new domain's records (step 12.1 and 12.2)

DNS can take hours to spread. Adding the new name to Railway and its records to Namecheap changes
nothing a visitor can see — the name simply becomes ready — so you may do **12.1 and 12.2 now**
and let them settle. Do **not** do 12.3 until you reach it.

---

## Step 1 — Back up the volume, and confirm where it is mounted

Everything the site knows — accounts, orders, quotes, customer files — is on one Railway volume.
Take a copy before anything changes.

1. Railway → project "pleasing-celebration" → click the service → the **volume** attached to it.
   Check **Mount path** reads `/app/data`.
   *If it reads anything else:* stop and ask before continuing — the site would start with an
   empty database.
2. The service → **Backups** tab → **Create backup** (a manual backup). Name it
   `before-go-live` with today's date.
   *You should see:* the backup appear in the list within a minute or two.
   *If Railway refuses with a size message:* a manual backup is limited to half the volume's size;
   the volume here is far below that, so tell me what it says.
3. Same tab → backup schedules: switch on **Daily** (kept 6 days) and **Weekly** (kept 27 days).
4. Write down the time. If step 5 goes wrong, this backup is what you come back to (Rollback,
   option C).
5. **If you have ever changed a material or finish in Admin on the live site** (a price, a
   thickness, switched one on or off): open Admin → Materials and Admin → Finishes now and write
   down what you changed. The new version carries a newer default catalogue, and on its first
   start it replaces the materials, finishes and processes lists with it (four SLA resins go,
   eight arrive). **A price you changed is kept**: the site knows what the old default was, so a
   price that differs from it is yours and is put back on the new list. What is not kept: a price
   on one of the four SLA resins that are gone, a material you added yourself, and anything you
   changed other than a price (a name, a thickness, switched off). Your pricing rules (rates,
   markups, minimums) are kept as you set them. After step 5, Admin → Pricing shows a box listing
   every price that was kept and every one that could not be; re-enter the rest from your notes.
   *If you never touched those two tabs:* nothing to do, and no box appears.

---

## Step 2 — Variables

Railway → the service → **Variables**. For each line: if it exists, check it; if not, **New
Variable**. Railway stages the changes; do **not** press Deploy yet (step 5 deploys everything
together). Generate secrets with your password manager's generator or the commands in
[`../security/file-encryption.md`](../security/file-encryption.md), step 1.

### Required for launch

| Variable | What to enter | Notes |
|---|---|---|
| `JWT_SECRET` | 48 or more random characters | If the existing one is shorter than 32 characters, replace it now: changing it later signs everyone out and resets two-step sign-in |
| `STRIPE_SECRET_KEY` | your live secret key from Stripe | Already there if the old site took payments |
| `STRIPE_PUBLISHABLE_KEY` | your live publishable key | |
| `STRIPE_WEBHOOK_SECRET` | the signing secret of the webhook endpoint, from Stripe (step 2a below) | **Confirm it is present before step 5.** You already have it set; from this release the site exits at startup without it |
| `ADMIN_EMAIL` | the address of your own existing account on the site | Exactly as you registered it. It names the admin account; it does not make one. Your account is already the admin on the volume and is left exactly as it is (step 5 shows the log line that confirms it) |
| `FRONTEND_URL` | for now: `https://nordmfg.com` | The address the site answers on today. You change it to the new domain in step 12, not before — links in emails and Stripe's return page use it |
| `EMAIL_API_KEY` | the Resend key from part A | **Required for launch** |
| `EMAIL_FROM` | `Straightedge <` + your sending address + `>` | **Required for launch.** The address must be on the domain you verified in part A |
| `RFQ_NOTIFY_TO` | the mailbox where you want orders, requests, alerts and the daily digest | **Required for launch.** One address, or several separated by commas |
| `TURNSTILE_SITE_KEY` | the Site Key from part B | **Required: the site exits at start-up without both.** The bot check is what stops a script from uploading, quoting and sending requests from many addresses at once |
| `TURNSTILE_SECRET_KEY` | the Secret Key from part B | **Required**, as above |
| `NORD_FILE_ENC_KEY` | 48 or more random characters | Follow [`../security/file-encryption.md`](../security/file-encryption.md). **Save it before you enter it**: if it is lost, stored customer files cannot be opened. Set it now so no customer file is ever stored unencrypted |

### Check, and normally leave unset

| Variable | Rule |
|---|---|
| `TRUST_PROXY_HOPS` | Leave unset (it defaults to 1, which is right for Railway alone). Set it to `2` only if you ever switch on Cloudflare's orange-cloud proxy for the site's DNS. Checked in step 13 |
| `NODE_ENV` | The image sets it. If the variable exists with any value other than `production`, delete it |
| `PORT` | Railway sets it. If you have one of your own, leave it as it is (the domain's target port matches it) |

### Must not exist — delete if present

`RAILWAY_RUN_UID`, `SE_TEST_HOOKS`, `EMAIL_OUTBOX_DIR`, `CSP_REPORT_ONLY`, `ADMIN_RECOVERY`,
`ADMIN_SETUP_CODE`, `ALLOW_LAUNCH_WITHOUT_BOT_CHECK`, and anything starting `NIXPACKS_`.

(`ALLOW_LAUNCH_WITHOUT_BOT_CHECK` lets the site start in production with no bot check. It exists
for test runs. On the public site it would switch off the protection the per-address limits
depend on.)

(`ADMIN_SETUP_CODE` and `ADMIN_RECOVERY` are for the two situations in step 6's table and are
removed again as soon as they have been used. With an admin account already on the volume,
`ADMIN_SETUP_CODE` does nothing; the log asks you to remove it, and Admin → System shows it as a
protection that is off until you do.)

### For step 12 (not now)

`CANONICAL_HOST`, `REDIRECT_HOSTS`. Later still: `HSTS_ALL_HOSTS`.

### Optional (defaults are fine)

| Variable | Default | What it does |
|---|---|---|
| `STRIPE_PROMOTION_CODES` | off | `on` shows the promotion-code box on Stripe's page, for every order and firm quote. Leave it off until you have decided to run codes (step 2a, item 3). The startup log and Admin → System say which way it is set |
| `CHECKOUT_SESSION_MINUTES` | 120 | How long a buyer has to finish paying on Stripe's page (30 to 1440). After that the unpaid order closes as "Not paid, closed" and the quote can be ordered again |
| `CHECKOUT_PER_ACCOUNT_15MIN` | 12 | How many times one account may press pay in 15 minutes before it is asked to wait a few minutes |
| `MEMORY_BUDGET_MB` | 1024 | The memory limit of the Railway service, in MB. The site sizes its file-reading limits from it. **Set it in step 3** to match the service: the recommended service size is 2 GB with `MEMORY_BUDGET_MB=2048` |
| `DB_MAX_MB` | 16 | The most the database file may grow to. Past it the site stops saving new quotes and uploads until room is made. **Check it in step 9**: if the database is already more than half of this on the first day, raise it |
| `QUOTE_DRAFT_KB_PER_CLIENT`, `QUOTE_DRAFT_KB_PER_ACCOUNT` | 512 each | How much unsaved-quote data one visitor, or one account, may have stored at once: roughly 180 one-part quotes, or 23 quotes of 100 parts. Orders, requests and quotes on them are never counted |
| `OPS_DIGEST_HOUR` | 7 | Hour of the daily digest, Central time |
| `OPS_DIGEST` | on | `off` stops the scheduled digest (the admin button still works) |
| `ADMIN_SESSION_HOURS` | 4 | How long an admin sign-in lasts |

Every other setting, with its default, is listed once in `.env.example` at the top of the
repository. That file is the one list: a test fails if a limit is added to the code and not to it,
or is shown there with a different default. A new, empty database also needs the one-time
admin setup code described in step 6 — not your case, because your account is already on the
volume.

### Step 2a — the Stripe webhook endpoint

1. Stripe Dashboard → **Developers** → **Webhooks** (in Workbench). You should find one endpoint
   whose address ends `/api/stripe/webhook`.
   - *If there is one:* note its address (it will be on `nordmfg.com` or on the Railway host).
     Open it → **Signing secret** → reveal → copy into your password manager → enter as
     `STRIPE_WEBHOOK_SECRET` in Railway. Leave the address alone for now; step 12 changes it.
   - *If there is none:* create one. Address: `https://nordmfg.com/api/stripe/webhook`. Payload:
     **Snapshot**. Then copy its signing secret as above.
2. Event types. Open the endpoint → **Edit** → the list of events. Enable exactly these six
   (the list the site handles: `HANDLED_EVENTS` in `server/routes/stripeWebhook.js`, checked
   against the merged code on 2026-11-12):

   - `checkout.session.completed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `refund.updated`
   - `charge.dispute.created`
   - `charge.dispute.closed`

   *You should see:* all six listed on the endpoint's page. With fewer, the site still takes
   payment but does not hear about refunds, disputes or lapsed checkouts. Any other event type
   sent to the address is answered 200 and ignored, so extra ones do no harm.
   While you are in the Dashboard, three settings to look at (the site does not set them):
   **Payment methods** — checkout asks for card only; do not switch on bank debits or other
   delayed methods for this integration. **Customer emails** — the site emails the customer an
   order confirmation and nothing on a refund; turn on Stripe's refund receipts if customers
   should be told by email. **Dispute notifications** — keep Stripe's own on: the site emails you
   too, but the deadline and the evidence form are in Stripe.
3. **Do not create promotion codes in Stripe yet.** The promotion-code box at checkout is off by
   default (`STRIPE_PROMOTION_CODES`). A code created now cannot be entered anywhere. When you
   decide to run codes: set `STRIPE_PROMOTION_CODES` to `on`, Deploy, then create the codes.
   Every active code then works on every order, firm quotes included. A code that takes 100% off
   never releases an order by itself: the order is flagged "nothing was collected" and waits
   for you.

---

## Step 3 — Railway build settings

Until 2026-12-01 Railway reads `railway.toml` from the repository and it overrides these fields.
From that date it reads only what is entered here. Enter them now so the two agree and nothing
changes on the day.

Railway → the service → **Settings**:

| Section | Setting | Enter |
|---|---|---|
| Source | Branch connected to production | `master` |
| Source | Root directory | leave empty |
| Build | Builder | **Dockerfile** |
| Build | Dockerfile path | `Dockerfile` |
| Build | Custom build command | **empty** — delete whatever is there |
| Build | Watch paths | empty |
| Deploy | Custom start command | **empty** — delete `npm start` if it is there |
| Deploy | Pre-deploy command | empty |
| Deploy | Healthcheck path | `/api/health` |
| Deploy | Healthcheck timeout | `300` |
| Deploy | Restart policy | **On Failure**, max restarts `100` (see below) |
| Deploy | Draining time (time to shut down gracefully) | `15` seconds |
| Deploy | Replicas | 1 |
| Config-as-code | Railway config file path | empty |
| Networking | Custom domains | leave as they are for now |

**Restart count: why 100 and not the default 10.** Railway restarts the site when it stops on an
error, up to this number, and then leaves it down until you redeploy by hand. A file built to
exhaust memory can get the whole site killed, and each kill uses one restart: at 10, ten such
uploads in a row take the site offline until you notice. At 100 there is room for that while a
deployment that can never start (a missing variable) still stops by itself. Every restart after a
kill or crash also sends you an alert email, so you will know long before the count matters.

**Memory: 2 GB, and tell the site.** Settings → **Resources** (or the service's **Metrics** tab →
Memory): note the service's **memory limit**.

1. Set the limit to **2 GB** if your plan allows. This is the recommended size.
2. Step 2, Variables: add `MEMORY_BUDGET_MB` with the same figure in MB: `2048` for 2 GB.
   The two must agree. The variable does not change what Railway gives the service; it tells the
   site how much it has, and the site sizes its file-reading limits from that.

What the figure changes for a customer: the largest models the site accepts (STL or 3MF near
500,000 triangles of loose, unconnected geometry) need about 1 GB to read. At 2 GB they are read
and priced. At the default of 1024 the site reads such a file by itself, with nothing else
running, and if it still does not fit it stops that one file and tells the customer "this model
is too heavy to price online, send it for a firm quote". Ordinary parts are read the same either
way. Nothing is ever killed silently: a file that cannot be read gets an answer that says why.

If you leave the service below 2 GB, set `MEMORY_BUDGET_MB` to whatever the limit is (for 1 GB:
leave it unset). Never set it higher than the service's limit: the site would then accept work
Railway kills it for.

*You should see, in step 5's deploy log:* a line beginning `Memory budget: 2048 MB
(MEMORY_BUDGET_MB)`. *Later, in Admin → System:* nothing about memory unless something went
wrong; an alert titled "The site was killed and restarted" is the sign that the limit was hit.

Why the start command must be empty: the image starts itself. It begins as root for one job —
making the volume writable — then runs the site as an unprivileged user. A start command typed
here can skip that.

*If a field is greyed out with a note that it is set in code:* that is `railway.toml` overriding
it until 2026-12-01. Leave it; the file says the same thing. Come back after step 14.

---

## Step 4 — Read this before merging

The next step puts the site back on the public internet. Before you press the button:

- [ ] Step 1's backup is in the list.
- [ ] Every "Required for launch" variable in step 2 is entered, **including
      `STRIPE_WEBHOOK_SECRET`, `EMAIL_API_KEY`, `EMAIL_FROM`, `RFQ_NOTIFY_TO`**.
- [ ] The Resend domain says Verified.
- [ ] Step 3's settings are saved.
- [ ] You have 45 minutes, your phone, and nobody waiting on you.

---

## Step 5 — Merge the pull request (this redeploys the site)

1. GitHub → `ELECODE103/ele-quoting-engine` → **Pull requests** → the launch pull request →
   **Merge pull request** → **Confirm merge**.
2. Railway → the service → **Deployments**. A new deployment starts by itself within a minute.
   (If you staged variable changes in step 2 and Railway shows a **Deploy** button, press it.)
3. Open the deployment → **Build Logs**.

*You should see, in the build log:*
- `Using detected Dockerfile!`
- three stages building, then near the end `prerender: 22/22 routes rendered`
- the build finishing without a red line. It takes a few minutes.

*Then, in **Deploy Logs**, in this order:*
- `entrypoint: making /app/data writable by node (volume mounted as root)` — the first time only
- `Upgrading catalogs: seed v3 → v4 (materials, finishes, processes)...` — the first time only:
  the default catalogue being brought up to date (step 1, item 5), followed by `Seeding materials...` and the
  like; then either `Catalogue: no price had been changed by hand, so there was nothing to carry over.` or one
  line per price, `Catalogue: kept your … price …` / `Catalogue: could NOT keep your … price …`, and a count;
  and `Pricing rules: added … new key(s), seed v4.` (the new settings, each at its default)
- `Admin account <your address>: present.` — your existing admin account was found and left as
  it is. (If you see `NOTICE: there is no admin account yet` or `WARNING: an ordinary account …
  already uses the ADMIN_EMAIL address` instead, go to step 6's table: "No admin account".)
- `Database ready.` and a line with the database size
- `Memory budget: 2048 MB (MEMORY_BUDGET_MB) — …; database ceiling 16 MB.` The first figure must
  be the service's memory limit from step 3. If it says 1024 and the service has 2 GB, the
  variable did not take
- `Payments: card checkout sessions stay open 120 minutes; promotion codes at checkout are off.`
- possibly, within the first minute of this first start, one line beginning **`Order sweep:`** —
  for example `Order sweep: 3 unpaid order(s) closed as expired, 0 settled late, 0 left for the
  next run (Stripe did not answer)`. Every card order that was left unpaid for more than a day
  under the old code is checked against Stripe (was it paid after all?) and, if not, closed. In
  Admin → Orders those change from "Awaiting payment" to **"Not paid, closed"**, and the quote
  each came from can be ordered again. That is expected clean-up, not an error. An order Stripe
  says *was* paid is marked paid instead ("settled late"); one Stripe could not be asked about is
  left for the next run, ten minutes later. No line at all means there was nothing to close.
  Orders taken by phone (no card page) are never closed this way
- `[seo] 22/22 public routes prerendered; canonical host straightedgemfg.com`
- `File encryption: on — …`
- `[hosts] CANONICAL_HOST is not set: …` (correct until step 12)
- `[ops] alerts by email and in this log; daily digest at 7:00 Central.`
- the box `Straightedge quote API on port …`
- **no** block starting `WARNING: BOT CHECK IS OFF` or `WARNING: THE ROBOT CHECK IS OFF`, **no**
  `WARNING: the database is already …`, **no** `WARNING: EMAIL_API_KEY…`, **no**
  `WARNING: the server is running as root`, **no** line starting `ALERT`

*Then:* the deployment turns green ("Active"), and `https://nordmfg.com/api/health` in your
browser shows `{"status":"ok", …}`.

*If you do not:*

| What you see | What it means | What to do |
|---|---|---|
| Build log: the `node:20.20.2-bookworm-slim` image "not found" | That exact image tag is not on Docker Hub | In the repository edit the first `FROM` line of `Dockerfile` to `node:20-bookworm-slim`, commit to `master`. Tell me |
| Build log stops in `npm ci` or `npm run build` | A dependency or the client build failed | Nothing is live. Send me the last 30 lines |
| Deploy log: `FATAL: Missing required environment variables: …` | A required variable is missing. `STRIPE_WEBHOOK_SECRET`, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are among them from this release: the site does not start without them | Add it (step 2), **Redeploy** |
| Deploy log: `FATAL: The robot check (Cloudflare Turnstile) is not set up, so the server will not start` | One or both Turnstile keys are missing | Part B, then step 2: enter both keys. **Redeploy**. Do not set `ALLOW_LAUNCH_WITHOUT_BOT_CHECK` to get past this |
| `WARNING: THE ROBOT CHECK IS OFF (ALLOW_LAUNCH_WITHOUT_BOT_CHECK is set …)` | The waiver variable is in Variables | Delete `ALLOW_LAUNCH_WITHOUT_BOT_CHECK`, enter both Turnstile keys; **Redeploy** |
| `WARNING: the database is already … of its … MB ceiling` | The existing database is large for the default ceiling | Step 2: set `DB_MAX_MB` to about four times the size the line gives (at least 64); **Redeploy** |
| `WARNING: STRIPE_WEBHOOK_SECRET does not look like a Stripe signing secret` | The value does not start `whsec_`: it is probably an API key or a secret from another endpoint | Step 2a, item 1: copy the endpoint's signing secret again; **Redeploy** |
| `WARNING: ADMIN_SETUP_CODE is still set` or `ADMIN_RECOVERY=…` warnings | A one-time setting was left in Variables | Delete it; **Redeploy** |
| Deploy log: `FATAL: NORD_FILE_ENC_KEY is only … characters` | The key is too short or a placeholder | Fix the variable, **Redeploy** |
| Deploy log: `FATAL: /app/data is not writable by uid …` | A `RAILWAY_RUN_UID` variable is set | Delete it, **Redeploy** |
| `WARNING: the server is running as root` | A start command or `RAILWAY_RUN_UID` bypassed the image's own start | Step 3: empty the start command; step 2: delete `RAILWAY_RUN_UID`; **Redeploy** |
| A warning block about the bot check, email or the webhook secret | That variable did not take | Check its exact name in Variables; **Redeploy** |
| `ALERT [startup-protections…]` with a list | The same, summarised: each name in the list is a setting that is off | Fix each; you also get this by email once email works |
| Deployment stays "Deploying" for five minutes and then fails | The site did not answer its health check | Read the Deploy Log from the top for the first `FATAL` or `Error`. If nothing explains it: Rollback, option A |
| The site is up but the database looks empty (no orders, your sign-in is unknown) | The volume is not mounted at `/app/data` | **Stop.** Do not register anything. Step 1, item 1; tell me |

---

## Step 6 — First sign-in and two-step enrolment

Everyone, including you, is signed out by this deploy.

1. Open `https://nordmfg.com/login`. Sign in with your existing address and password.
2. Go to `/admin`. Instead of the admin pages you see **"Set up two-step sign-in to open the admin
   pages."** That is expected: nothing in the admin area opens until this is done.
3. Enter your password → a QR code appears → scan it with your authenticator app (Google
   Authenticator, 1Password, Authy…) → type the 6-digit code.
4. Ten **recovery codes** are shown, once. Put them in your password manager or print them. Not
   on the phone that has the app. Press **I have saved them**.
5. You get an email: "two-step sign-in is on". (This is also your first proof that email works.)

*You should see:* the admin pages, with tabs from Orders to **System**.

*If you cannot sign in:*

| Problem | Way back in |
|---|---|
| Forgot the password | `/forgot-password` → the emailed link (needs step 2's email settings working) |
| "Sign-in from this connection is paused for N minutes" | Several wrong passwords in a row from the browser you are on. The wait starts at one minute and grows to fifteen. Wait it out, or press **Choose a new password** in the message: the browser that completes a reset is let straight in. Nobody else's wrong guesses can lock you out: there is no longer a lock on the address itself |
| "…we only sign it in from a browser it has used before" | Someone has been guessing at your address from elsewhere. Sign in from the browser you normally use, or choose a new password |
| "Too many wrong codes" | Five wrong two-step codes in 15 minutes from a browser the account has not used. Wait the minutes shown, then enter the code the app shows then |
| Lost the phone **and** the recovery codes (later on) | Railway → Variables → add `ADMIN_RECOVERY` with the value `reset-2fa` → Deploy → sign in with your password → enrol again → **delete the variable** → Deploy. The log prints a warning every start until it is removed |
| The code is always "didn't match" | The phone's clock is off. Set it to automatic time |
| **No admin account** — a brand-new, empty database (a fresh volume), or the deploy log says `NOTICE: there is no admin account yet` / `WARNING: an ordinary account … already uses the ADMIN_EMAIL address`. Not your case if step 5 showed `Admin account …: present.` | The admin account is made once, out of band, with a **setup code that you invent** (nobody gives it to you and the site never shows it): 20 characters or more, not a word or a repeated letter. (1) Railway → Variables → add `ADMIN_SETUP_CODE` with that code → Deploy. (2) The deploy log says `there is no admin account yet. The one-time admin setup is OPEN at /admin/setup`. (3) Open `https://<the site>/admin/setup`, enter the code and choose your password. (4) You land in two-step enrolment exactly as above. (5) **Delete `ADMIN_SETUP_CODE`** → Deploy. The code stopped working the moment the account was made; the log reminds you until the variable is gone. The admin address cannot be registered from the public pages, and confirming an email never makes anyone an admin |
| Locked out with no working mailbox (cannot use "forgot password") | Railway → Variables → add `ADMIN_RECOVERY` with the value `setup-code` **and** a *new* `ADMIN_SETUP_CODE` (not one used before) → Deploy → open `/admin/setup`, enter the code, choose a new password → enrol in two-step sign-in again → **delete both variables** → Deploy. (`ADMIN_RECOVERY=verify-email` from earlier notes no longer exists: it does nothing and the log says so) |

---

## Step 7 — Check the prices are the ones you set

Admin → **Pricing** → the **Shop** group.

*You should see:* **Mill rate**, **Lathe rate** and **Router rate** each at `110` $/h, and the
margin at `50` %.

*If any differs:* do not edit it here in a hurry. Open **History** on the same page and look at
who changed what and when; tell me what you find. Nothing in this launch changes pricing.

**Whenever you do change a price** (now or later): a quote a buyer has already saved keeps its
price for 30 days — that is the price hold the site promises, honoured only for exactly what was
priced and never below half of today's price. If you do not want earlier quotes bought at the old
prices, go to Admin → **Change log** → type a reason → **End price hold on open quotes**. Nothing
is deleted: each buyer reopens their quote and sees today's price. Orders already paid and firm
quotes you have sent are not affected. The same tab lists every change made in Admin — prices,
materials, finishes, lead times, orders moved by hand — with who and when.

---

## Step 8 — The bot check is visible

1. Open a private (incognito) window → `https://nordmfg.com/register`.
   *You should see:* a small Cloudflare box above the Create-account button; it usually ticks
   itself.
2. Same window → `/rfq`. The same box above Send.

*If the box is missing:* Railway deploy log — is a `BOT CHECK IS OFF` or `ROBOT CHECK IS OFF`
block there? Then a key did not take, or the waiver variable is set (step 2). *If it shows an error about the domain:* the hostname you are on is not in
the widget's list (part B, item 2). *If it says the check could not load:* an ad blocker in that
browser; try another. Cloudflare's real widget has not been run against the site before today, so
tell me whatever you see here that is not a ticking box.

---

## Step 9 — Admin → System, and the email check

1. Admin → **System**. (What the page looks like: [`screens/admin-system-tab-1360.png`](screens/admin-system-tab-1360.png)
   — taken on a test server with the protections deliberately off, so yours should show far
   fewer red tags.)
   *You should see:* no red banner; **Build** shows a commit; every line under **Protections** is
   **on** except *Canonical host* (set in step 12).
   *If a protection is off:* the line under it says which variable to set.
2. Press **Send a test email**.
   *You should see:* a list ending "Email is working: a test message is on its way to the shop
   inbox", and within a minute an email "Straightedge email check" in the `RFQ_NOTIFY_TO` mailbox.
   Look in spam too.
   *If a line says FAIL:* it says why in words — key refused, domain not verified, limit reached.
   Fix that in Resend or in Variables and press it again. *If it arrived in spam:* recheck part A,
   items 2 and 3 (DKIM and DMARC).
3. Press **Send the digest now**. A "daily digest" email arrives. From tomorrow it comes by itself
   at 7 am Central.
4. Press **Download full backup** and keep the file somewhere safe (it holds customer data).
   This is your copy *outside* Railway.
5. On the same page, under **Storage**, read the **Database** line: size, ceiling and percent.
   *You should see:* well under half. The ceiling is 16 MB unless you set `DB_MAX_MB`. A save
   rewrites the whole file, which is why the ceiling is small: about 1 to 3 ms per MB.
   *If it is over half:* set `DB_MAX_MB` to about four times the size shown (at least 64) and
   redeploy. At 80 % the site starts clearing unsaved quotes of whoever holds the most; at 85 %
   visitors without an account are asked to sign in before quoting; at 100 % new quotes and
   uploads are refused for everyone. Orders, requests and anything on them are never cleared.

The same check from a terminal, if you ever need it: `railway ssh -- npm run email:check`.

---

## Step 10 — A real order, end to end, and its refund

Use your own card and a second email address of your own (not the admin one).

1. Private window → `/quote` → upload a small STEP or STL → pick a material → quantity 1.
   *You should see:* a price within a few seconds.
2. **Checkout** → create an account with the second address.
   *You should see:* "confirm your email" and the pay button switched off; an email with a link
   arrives; after you open the link the pay button switches itself on.
3. Enter a ship-to address → **Pay** → you land on `checkout.stripe.com` → pay with your card.
4. Stripe sends you back to the order page.
   *You should see, within seconds:*
   - the order page showing **paid** and a ship-by date
   - an order confirmation in the buyer's mailbox
   - **"New order … — $…"** in the shop mailbox (one email, not two)
   - Railway deploy log: nothing new. A payment that settles cleanly is not logged; a line
     beginning `Stripe webhook … order flagged` or `Webhook signature verification failed` is
     the thing to look for, and there should be none
   - Stripe → Developers → Webhooks → your endpoint → **Event deliveries**:
     `checkout.session.completed` with status **200 / Delivered**
   - Admin → Orders: the order, paid

   *If the order shows paid but Stripe's delivery shows 400:* `STRIPE_WEBHOOK_SECRET` is not this
   endpoint's secret (the page marked the order paid by asking Stripe directly, which is the
   fallback). Fix the variable, redeploy, then **Resend** the event in Stripe.
   *If Stripe's delivery shows a redirect (301 / 308):* the endpoint's address is on a host that
   redirects. It must be a host that serves the site directly; see step 12.
   *If no shop email arrived:* Admin → System → "Send a test email".
5. Admin → Orders → open the order → download the part file.
   *You should see:* it opens in your CAD program (this proves file encryption round-trips).
6. **Refund it.** Stripe Dashboard → **Payments** → the payment → **Refund** → full amount.
   *You should see:* the payment marked Refunded in Stripe; within a minute the order in Admin →
   Orders changes to **Refunded** and leaves the production queue, and one email arrives in the
   shop mailbox, "Order … : refunded in full — $…"; Stripe's Event deliveries show
   `charge.refunded` with status 200. The buyer's order page says the order was refunded and
   the amount. The site sends the buyer no email about it (Stripe's own refund receipt does, if
   you switched it on in step 2a). *If the order still says paid:* the `charge.refunded` event type is not enabled on
   the endpoint (step 2a, item 2) — enable it and press **Resend** on the event. Stripe keeps its
   processing fee on a refund.

---

## Step 11 — Pause

The site is live on the old address, protected, taking orders and emailing you. If it is late in
the day, stop here. Steps 12 to 14 can be done tomorrow.

Do not leave step 12 for long, though: the pages and the footer of every email already name
`straightedgemfg.com`, and that link opens nothing until step 12 is done. Step 14 has a date.

---

## Step 12 — Domain cutover: straightedgemfg.com

Goal: the site answers on `straightedgemfg.com`; `www.straightedgemfg.com`, `nordmfg.com` and
`www.nordmfg.com` send visitors to the same page there; Railway's own address stays out of
search results. The order below never leaves a moment where a visitor gets a certificate error or
a dead link: each new name is working before anything points at it.

### 12.1 Add the new names in Railway

Railway → the service → Settings → **Networking** → **+ Custom Domain**. Add
`straightedgemfg.com`. Choose the port the list offers (the one already used by the existing
domain). Railway shows **two records**: a CNAME target ending `.up.railway.app` and a TXT record.
Leave that page open. Then add `www.straightedgemfg.com` the same way; it has its own two records.

(Four custom domains are needed in the end. Railway's Hobby plan allows two per service; the Pro
plan allows twenty.)

### 12.2 Add the records in Namecheap

Namecheap → Domain List → **Manage** `straightedgemfg.com` → **Advanced DNS** → Host Records.

1. **Remove what is in the way.** A new Namecheap domain comes with a `CNAME` for `www` pointing
   at `parkingpage.namecheap.com` and a `URL Redirect Record` for `@`. Delete both. Delete any `A`
   or `AAAA` record for `@` or `www` as well. Do **not** touch MX records, TXT records, or
   anything you added in part A.
2. **The bare domain (`@`).** Add:
   - Type **ALIAS Record**, Host `@`, Value: the CNAME target Railway shows for
     `straightedgemfg.com`, TTL 5 min.
   - Type **TXT Record**, Host and Value: exactly as Railway shows for `straightedgemfg.com`.
3. **www.** Add:
   - Type **CNAME Record**, Host `www`, Value: the CNAME target Railway shows for
     `www.straightedgemfg.com`, TTL Automatic.
   - Type **TXT Record**, Host and Value: exactly as Railway shows for `www.straightedgemfg.com`.
4. **Save All Changes.**

Why ALIAS for `@` and not CNAME: an ordinary CNAME on the bare domain cannot share the name with
other records, and your mail records live on the bare domain. Namecheap's ALIAS type is made for
this ("ALIAS can coexist with other records on that name"). Railway's documentation lists
Namecheap as working with a CNAME at the root and says it supports ALIAS records in general; the
two vendors describe it differently and I could not test it on your account, so:

- *If Railway has not verified the bare domain after an hour with the ALIAS record:* change that
  one record's Type to **CNAME Record** (same Host `@`, same Value) and wait again. Then send
  yourself an email from outside to make sure mail to the domain still arrives; if it does not,
  switch back to ALIAS and use the fallback below.
- *Fallback if neither works:* move the domain's DNS to Cloudflare (free): add the site in
  Cloudflare, copy every existing record across (Cloudflare imports them — check the mail records
  against your part A screenshot), change the nameservers at Namecheap to the two Cloudflare
  gives you, then add a CNAME for `@` with the grey "DNS only" cloud. Keep the cloud grey: the
  orange proxy needs `TRUST_PROXY_HOPS=2` and different certificate handling.

*You should see:* in Railway → Networking, a green tick beside both names, normally within the
hour (DNS can take up to 72 hours). Then `https://straightedgemfg.com/api/health` shows
`{"status":"ok"…}` with a padlock, and so does `https://www.straightedgemfg.com/api/health`.

*If the browser shows a certificate warning:* the certificate has not been issued yet. Wait; do
not go on. *If it shows Railway's "not found" page:* the TXT record is missing or mistyped.

At this point the site answers on the new name as well as the old one. Nothing has been switched.

### 12.3 Switch the site to the new name

Only when both health addresses in 12.2 work with a padlock:

Railway → Variables:

| Variable | Value |
|---|---|
| `CANONICAL_HOST` | `straightedgemfg.com` |
| `REDIRECT_HOSTS` | `www.straightedgemfg.com,nordmfg.com,www.nordmfg.com` |
| `FRONTEND_URL` | change to `https://straightedgemfg.com` |

Press **Deploy**. (About a minute of downtime: a service with a volume stops before its
replacement starts.)

*You should see, in the deploy log:*
`[hosts] canonical host straightedgemfg.com; redirecting to it: www.straightedgemfg.com, nordmfg.com, www.nordmfg.com; noindex on …up.railway.app; HSTS on the canonical host only.`

*Then check, in a private window:*

| Open | You should see |
|---|---|
| `https://straightedgemfg.com/` | the home page |
| `https://www.straightedgemfg.com/materials/uhmw` | lands on `https://straightedgemfg.com/materials/uhmw` |
| `https://nordmfg.com/materials/uhmw?x=1` | lands on `https://straightedgemfg.com/materials/uhmw?x=1` |
| `https://nordmfg.com/api/health` | `{"status":"ok"…}` — **not** redirected (on purpose) |
| `https://straightedgemfg.com/sitemap.xml` | 22 addresses, all on `straightedgemfg.com` |
| the Railway address (`….up.railway.app`) | the site (it is kept working, and marked no-index for search engines) |
| Admin → System → *Requests have arrived for* (after signing in again, below) | `straightedgemfg.com` is in the list |

*If `nordmfg.com` still shows the site instead of moving you, and that list does not contain
`straightedgemfg.com`:* Railway is not passing the visitor's host name to the site the way this
relies on. Remove `CANONICAL_HOST` and `REDIRECT_HOSTS`, Deploy, and tell me — nothing is broken
without them; the old names simply keep serving the site.
*If a WARNING line appears under `[hosts]`:* it says which setting it could not use (a typo in a
host name, or `FRONTEND_URL` not matching). Fix and Deploy.
*If the browser says "too many redirects":* `CANONICAL_HOST` was set to the `www` name. It must be
the bare domain.

Sign in again at `https://straightedgemfg.com/login` — the sign-in cookie belongs to one host, so
the move signs you out once. Then repeat step 8 (the Cloudflare box) on the new address.

### 12.4 Point Stripe at the new name

Stripe keeps delivering to the old address in the meantime — the webhook is deliberately never
redirected — so there is no gap.

1. Stripe → Developers → Webhooks → your endpoint → **Edit** (or ⋯ → Update details) → change the
   address to `https://straightedgemfg.com/api/stripe/webhook` → save. Editing the address keeps
   the same signing secret, so `STRIPE_WEBHOOK_SECRET` does not change. (Do **not** add a second
   endpoint instead: it would have a different secret and the site knows only one.)
2. Prove it: in the quote tool start a checkout, and on Stripe's page press the back arrow.
   *You should see:* you return to the checkout page on `straightedgemfg.com`.
   Then on the endpoint's page in Stripe press **Send test event** (or resend the event from step
   10). *You should see:* status **200** in Event deliveries.

### 12.5 Bring the old domain's names under Railway (if they are not already)

`nordmfg.com` already points at this service. Check that `www.nordmfg.com` does too: Railway →
Networking should list both, each with a green tick. If `www.nordmfg.com` is missing, add it as a
custom domain and add its two records at whoever holds `nordmfg.com`'s DNS, the same way as 12.2.

Keep `nordmfg.com` registered and pointed here for at least a year (decision D2): every old link,
bookmark and search result lands on the right page for as long as it is.

### 12.6 Later: HSTS on every host

For now browsers are told "HTTPS only, for a year" on `straightedgemfg.com` alone. When you have
decided that `nordmfg.com` stays on Railway for the long run, add `HSTS_ALL_HOSTS` = `true` and
Deploy. There is no hurry and no harm in never setting it.

---

## Step 13 — Search engines, the outside monitor, and one network check

### Search Console

1. <https://search.google.com/search-console> → **Add property** → **Domain** →
   `straightedgemfg.com`. Google shows a TXT record: add it in Namecheap (Type TXT, Host `@`) →
   Save → **Verify**.
2. **Sitemaps** → enter `https://straightedgemfg.com/sitemap.xml` → Submit.
   *You should see:* "Success", 22 discovered pages (within a day).
3. If `nordmfg.com` was ever in Search Console: open that property → Settings → **Change of
   address** → choose the new property. Google checks the redirects from step 12.3 itself.
4. **URL inspection** → paste the Railway address of the home page.
   *You should see:* "Excluded by 'noindex' tag" — that is the intent.

### An outside monitor (two minutes)

Railway's health check runs only at deploy time; it does not watch the site afterwards. A free
outside monitor does. Recommended: UptimeRobot — its free plan allows business use, 50 monitors,
a check every 5 minutes.

1. Sign up at uptimerobot.com with the shop's email (you do this; nothing is signed up for you).
2. **New monitor** → type **HTTP(s)** → URL `https://straightedgemfg.com/api/health` → name
   `Straightedge site` → interval 5 minutes → alert contact: your email (add your phone for a
   text if you want) → **Create monitor**.
3. *You should see:* "Up" within five minutes. To prove the alert works, pause the monitor's URL
   to a wrong path for one check, see the email arrive, and put it back.

### One network check: are visitors told apart?

The limits (uploads per network, sign-in attempts) rely on the site seeing each visitor's own
address. On your phone, **Wi-Fi off**, open `https://straightedgemfg.com/api/materials` — then
the same on a computer on the shop's Wi-Fi. In each browser's developer tools (Network → the
request → Response headers) find `RateLimit-Remaining`.
*You should see:* each device counting down from its own number (both near 199, not one
continuing from the other).
*If they share one count:* something is proxying in front of Railway (Cloudflare's orange cloud).
Set `TRUST_PROXY_HOPS` to `2`, Deploy, check again.

---

## Step 14 — Before 2026-12-01: Railway stops reading `railway.toml`

On 2026-12-01 Railway stops reading the configuration file in the repository ("hard cutoff", in
their words). From then on the service runs on the settings from step 3 alone. Step 3 already
entered them, so the day should pass unnoticed. To be sure:

1. **Any day before 12-01:** Railway → Settings — go down the step 3 table once more and confirm
   each field. Fields that were greyed out in step 3 may only become editable after the cutoff.
2. **On or just after 12-01:** Railway → Deployments → ⋯ on the active deployment → **Redeploy**.
   *You should see:* the same build log (`Using detected Dockerfile!`) and the same deploy log as
   step 5. Then go down the step 3 table a last time and fill in anything that is now editable
   and empty — above all **Healthcheck path**, **Draining time** and **Restart policy**.
3. *If the build log says Railpack instead of Dockerfile:* Settings → Build → Builder →
   Dockerfile → Redeploy.
4. After that, `railway.toml` can be deleted from the repository. It does nothing.

Also put in your calendar: **Node 20**, which the site runs on, has been out of security support
since April 2026. Moving to Node 22 is one line in the `Dockerfile` plus a test run; ask for it in
the first month (decision D3).

---

## Rollback

Three options, mildest first. Decide by what is wrong.

### A. Take the site offline (no data lost)

*When:* something is wrong and you want time to think. This is the state you started from.

Railway → Deployments → ⋯ on the active deployment → **Remove**. Visitors see Railway's "not
found" page. Nothing on the volume changes. Orders already paid are safe in the database and in
Stripe. To come back: Deployments → ⋯ on the deployment you want → **Redeploy**.

### B. Go back to the previous deployment (no data lost)

*When:* a new deploy broke something that worked on the one before it.

Railway → Deployments → find the last deployment that worked → ⋯ → **Redeploy** (or
**Rollback**). The database is untouched: everything customers did in between is still there.

**Not across this launch.** The deployment before step 5 is the old site. The new code has moved
part previews and large geometry out of the database into files; the old code does not know where
they went, and it lacks every security fix. Do not redeploy it over today's data. If the launch
itself has to be undone, use A, or C.

### C. Restore the volume backup (data since the backup is lost)

*When:* the data itself is damaged — the database is corrupt, files were deleted — or the launch
must be undone completely.

1. Option A first: take the site offline, so nothing more is written.
2. Railway → the service → **Backups** → the backup you want (step 1's `before-go-live`, or a
   daily) → **Restore**. Railway creates a new volume from it, mounted at the same path, and
   stages the change → **Details** → **Deploy**. The old volume stays in the project, unmounted —
   do not delete it until you are sure.
3. If restoring `before-go-live`: also redeploy the old deployment (option B's button), since
   that data belongs to the old code. Otherwise redeploy the current one.

**What is lost:** everything written after the backup was taken — accounts registered, quotes,
requests, orders, uploaded files, price changes you made in Admin, your two-step enrolment if it
was done after the backup (re-enrol; if the code no longer matches, use `ADMIN_RECOVERY`
= `reset-2fa`, and remove it afterwards). **What is not lost:** payments. Every payment taken is in Stripe (Payments), each
carrying its order id; an order paid after the backup has to be re-entered by hand from Stripe
and the "New order" email you received. Emails already sent stay sent.

The two secrets must be the ones in use when the backup was made: `JWT_SECRET` (sign-in,
two-step) and `NORD_FILE_ENC_KEY` (customer files). If the file key was changed since, put the
old one in `NORD_FILE_ENC_KEY_PREVIOUS`.

### Restoring from the downloaded full backup (last resort)

*When:* the Railway volume **and** its backups are gone, or you need the data on another machine.

The file from Admin → System → **Download full backup** holds the database and every customer
file. On any computer with the repository and Node:
`npm run restore -- <the file> --to <an empty folder>`, then start the site with that folder as
its data folder and the same two secrets. This path is tested end to end (order, quote, preview
and files all come back). Getting the file back onto a fresh Railway volume uses `railway ssh`
(it supports file copy) followed by the same command on the server with the site stopped; I have
not been able to try that part on Railway — ask before relying on it.

---

## The first week

**Every morning (2 minutes)**
- [ ] The daily digest arrived (7 am Central). No digest = email is broken or the site is down:
      check UptimeRobot, then Admin → System → "Send a test email".
- [ ] In it: *Requests waiting* — answer them; *orders needing a look* — open them; *failures* —
      should read "nothing failed".

**Whenever an "alert" email arrives** — the subject says what; the body says what to do. The same
alert is not repeated for six hours, so one email means "now".

**Day 2**
- [ ] Railway → Backups: a Daily backup is in the list.
- [ ] Admin → System: counters make sense; *Previous run ended* says "cleanly".

**Once during the week**
- [ ] Stripe → Developers → Webhooks → Event deliveries: no failed deliveries.
- [ ] Resend → Emails: nothing bounced or marked as spam.
- [ ] Search Console → Pages: the count is climbing toward 22; nothing from `up.railway.app`.
- [ ] Admin → System → Storage: customer files and database both far below their ceilings
      (alerts come at 80%).
- [ ] Admin → System → **Download full backup**; keep two, delete older ones.
- [ ] Admin → RFQs: decline anything that is obviously spam — its files are only cleaned up once
      the request is closed.

**What to watch for, and what it means**

| You see | It means | Do |
|---|---|---|
| Alert "started with N protections switched off" | A variable is missing after a deploy | Admin → System → Protections; fix; redeploy |
| Alert "Stripe webhooks are being refused (signature)" | Secret mismatch, or someone probing the address | Compare the secret; resend failed events in Stripe |
| Alert "Emails are failing to send" | Resend problem (limit, domain, key) | Resend dashboard; then the test email button |
| Alert "answering with server errors" | A bug or an overloaded server | Deploy log for `→ 500`; if it began with a deploy, Rollback B |
| Alert "restarted after a crash" | Railway restarted the site after an error | Once: note the time. Repeating: Rollback B and tell me |
| Alert "was killed and restarted" | The container ran out of memory (usually a huge or hostile upload), or a deploy happened with the draining time at 0 | Railway → Metrics → Memory at that time; step 3's memory and draining settings |
| Alert "N orders need a look" | Orders flagged for you. The alert lists how many of each: *Duplicate payment*, *Late payment* (money arrived for an order that was cancelled or had closed), *Payment does not match the order*, *Nothing was collected* (a 100% promotion code), *Payment disputed*, *Refund problem*. A flagged order keeps its status; nothing was cancelled or refunded for you | Admin → Orders → the order: the banner says what happened. Deal with it in Stripe (refund the extra payment, answer the dispute), then **clear the flag with a note**. The alert stops when no order is flagged |
| Alert "Upload storage is N% full" | Customer files are accumulating | Decline spam requests; if genuine, raise `UPLOAD_DIR_MAX_MB` (the volume has room) |
| Alert "The database is N% of its ceiling" | Unsaved quotes are piling up, or the business has outgrown the 16 MB default | Admin → Quotes → **Clear old drafts**. If it is still above half afterwards, it is real orders and requests: raise `DB_MAX_MB` (double it) and redeploy |
| UptimeRobot "Down" | The site is not answering from outside | Railway → Deployments: is one Active? Deploy log. Railway's status page |
| Digest: "told busy" or "timed out" counts above a handful | Customers' models are heavy for the instant quote | Normal in small numbers; they are offered a firm quote. Tell me if it grows |
| Digest: "All orders by status" | The states are the site's own: *awaiting payment*, *PO to confirm*, *paid*, *received*, *in production*, *quality check*, *packing*, *shipped*, *delivered*, *expired* (never paid; shown as "Not paid, closed" in Admin), *cancelled*, *refunded*, and *paid, under review* (older orders only). "— needs a look" beside a state counts the flagged orders in it; "partly refunded" and "with a payment dispute open" are counted on their own lines | Nothing, unless "needs a look" appears: then Admin → Orders |
| Digest: a status marked "(new status)" | An order state added by a later release that the digest has no name for yet | Nothing; every state is listed with its count so that none is missed |
| Digest: "Sign-in: accounts sent a wrong-passwords notice / attempts told to wait" | Someone guessing passwords. The first number is accounts whose owner was emailed "wrong passwords were tried on your account" (once a day at most); the second is sign-in attempts answered "wait". Nobody is locked out by this | Nothing for small numbers. If one of the accounts is yours, change your password |

What the counters do **not** remember: they start from zero at every restart or deploy (the
digest and the System page say when counting began). Orders, requests and sizes are always read
fresh.
