# Encrypting customer files at rest

**Status on 2026-11-11: off in production.** `NORD_FILE_ENC_KEY` is not set, so every file a
customer sends is stored on the Railway volume exactly as it arrived. The server says so in the
deploy log each time it starts.

This page is for the owner. It explains what turning encryption on does, and gives the exact steps
to create the key and enter it in Railway. **You create the key yourself.** Nobody else — not a
developer, not an assistant, not Claude — should generate it, see it, or be sent it.

## What it protects, and what it does not

With a key set, these are encrypted with AES-256-GCM before they are stored:

| What | Folder on the volume | How it is read back |
|---|---|---|
| CAD uploads (STEP, STL, 3MF, IGES, DXF) | `data/uploads` | Admin → Parts → download; re-reading a DXF when the buyer changes its units |
| The drawing a buyer attaches to an instant quote | `data/quote-drawings` | The buyer's or the admin's order page → drawing |
| RFQ attachments (drawings, photos) | `data/rfq-drawings` | Admin → RFQs → drawing |
| Each part's 3D preview mesh, and the measured detail of very detailed models | `data/part-payloads` | The quote tool, when a quote is reopened; pricing, for the few models whose detail is too large for the database row |

Encrypted files have a name ending in `.enc`. They are decrypted in memory only, for a signed-in
admin's (or the buyer's own) download. Nothing is ever decrypted to disk.

It protects against someone who gets a copy of the volume — a disk snapshot, a volume backup, a
support export — without also getting the Railway variables.

It does **not** protect:

- **The database** (`data/quoting.db`). Customer names, emails, addresses, quote and order history
  are in it unencrypted. So are the measurements of every uploaded part (size, volume, hole counts).
  The 3D preview mesh is no longer in the database: since 2026-11-11 it is a file under
  `data/part-payloads` and is encrypted with the rest. Treat a database backup as confidential.
- Against anyone who can open the Railway project: they can read the variable.
- Files uploaded **before** the key was set. They stay as they are. CAD uploads that are not on an
  order age out after 7 days; drawings and files on orders and open requests stay until removed.
  The simplest way to have nothing unencrypted is to set the key before the site takes real files.

## Before you start

- Have a password manager entry ready (1Password, Bitwarden, or the like). **The key must be kept.**
  If it is lost, every file stored under it is permanently unreadable — there is no reset.
- Ten minutes at a computer, signed in to Railway.

## Step 1 — Generate the key (on your own computer)

Use any one of these. Each prints one line of about 64 characters. That line is the key.

**Windows (PowerShell):**

```powershell
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

**Mac or Linux (Terminal):**

```sh
openssl rand -base64 48
```

**Anywhere Node is installed:**

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

A password manager's generator is fine too: 48 or more random characters, letters and digits.

Rules for the key:

- At least 32 characters. The server refuses to start with a shorter one (see Step 4).
- Random. Not a phrase, not a reused password.
- Do not paste it into chat, email, a ticket, a text file in the project, or a commit. Do not send
  it to a developer "to set up for you".

## Step 2 — Save it

Paste the key into a new password-manager entry named `Straightedge file encryption key
(NORD_FILE_ENC_KEY)` with today's date. Save. Then clear your terminal window.

## Step 3 — Enter it in Railway

1. Open the Railway dashboard → the Straightedge project → the web service.
2. Open the **Variables** tab.
3. **New Variable**. Name: `NORD_FILE_ENC_KEY` (exactly; the name is kept from an earlier version of
   the site). Value: paste the key. Add it.
4. Railway shows the change as staged. Press **Deploy** to apply it.

## Step 4 — Check the deploy log

Open the new deployment's log. One of three things is there:

- `File encryption: on — new CAD uploads, quote drawings and RFQ attachments are stored encrypted (AES-256-GCM).`
  → it worked.
- `FATAL: NORD_FILE_ENC_KEY is only N characters long…` or `…looks like a placeholder…`
  → the value is unusable. The deployment stops and Railway keeps the previous version running, so
  the site stays up. Fix the variable and deploy again.
- `WARNING: NORD_FILE_ENC_KEY not set — customer files are stored UNENCRYPTED…`
  → the variable was not saved on this service. Check its name and that you pressed Deploy.

The key itself never appears in the log.

## Step 5 — Check it end to end

1. On the live site, upload a small part to the quote tool.
2. Sign in as admin → **Parts** → download that part. It should open normally in your CAD program.
3. Optional: in Railway, open the volume's file browser (or a shell) and look in `data/uploads`. The
   newest file's name ends in `.enc`.

## Changing the key later

Do not simply replace the value: files stored under the old key would stop opening.

1. Generate a new key (Step 1) and save it (Step 2). Keep the old entry.
2. In Railway, add `NORD_FILE_ENC_KEY_PREVIOUS` with the **old** key as its value.
3. Change `NORD_FILE_ENC_KEY` to the **new** key. Deploy.

New files are encrypted with the new key; files under the old key still open. Several old keys can
be listed in `NORD_FILE_ENC_KEY_PREVIOUS`, separated by commas. Remove an old key only when nothing
stored under it is still needed.

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Downloading a part or drawing gives "This file is encrypted with a key this server does not have" | The key was changed or removed | Put the earlier key in `NORD_FILE_ENC_KEY_PREVIOUS` (or back in `NORD_FILE_ENC_KEY`) and deploy |
| A buyer changing a DXF's units is told to upload the file again | Same cause | Same fix; the buyer can also simply re-upload |
| A reopened quote shows the part without its 3D preview | The preview mesh was stored under a key the server no longer has | Same fix. The quote still opens and prices; only the picture is missing |
| A buyer re-pricing a very detailed part is told "we can no longer read what we measured from this file" | Same cause, for a model whose measured detail is kept in a file | Same fix; the buyer can also simply re-upload |
| The key is lost for good | Files stored under it cannot be recovered | Quotes, prices and orders are unaffected (they use the database). Ask the customer for the file again when a job needs it |
| The site will not deploy after you set the key | The key is too short or a placeholder | See Step 4; the previous deployment is still serving |

Turning encryption **off** again (removing the variable) does not decrypt anything: files already
encrypted stay unreadable until the key is put back.

## How it works, for whoever maintains the code

`server/services/fileCrypto.js`. Key = SHA-256 of the variable's text. Each file gets a fresh
96-bit nonce; the file on disk is `"SEF1" | key id (4 bytes) | nonce (12) | tag (16) | ciphertext`.
The key id is the first four bytes of an HMAC of a fixed label under the key: it tells which key
wrote a file without revealing the key. A file that fails authentication (altered, truncated, wrong
key) is refused before any plaintext is returned. Tests: `server/services/fileCryptoKeys.test.js`
and `server/security/fileEncryption.test.js` (keys are random, generated when the test runs).
