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
| Each part's 3D preview mesh, and everything measured from the part's shape: the outline and hole positions of a DXF, the recognised holes, pockets and walls of a model | `data/part-payloads` | The quote tool, when it shows a part; pricing, every time a part is priced |

Encrypted files have a name ending in `.enc`. They are decrypted in memory only (a preview is
decrypted as it is sent, after the file has passed its integrity check), for the browser that holds
the part, a signed-in admin's download, or the buyer's own drawing. Nothing is ever decrypted to disk.

**Since 2026-11-11, with a key set, nothing of a part's shape is kept in the database.** Before
that, a small DXF's whole outline and a small model's preview mesh stayed in the database row
(under 64 kB and 16 kB), in the clear, whatever the key. Now every part's shape data goes to an
encrypted file under `data/part-payloads` when a key is set, and at the first start with a key
the rows stored earlier are moved the same way. The row keeps numbers only: overall size, volume,
area, counts of holes and triangles, and for a DXF its units.

It protects against someone who gets a copy of the volume — a disk snapshot, a volume backup, a
support export — without also getting the Railway variables.

It does **not** protect:

- **The database** (`data/quoting.db`). It is not encrypted. Exactly what is in it, in the clear:
  - customer names, emails, phone numbers, shipping addresses, quote and order history, prices;
  - **the file name of every upload and attachment** as the customer typed it (`bracket-rev-B.step`);
  - for every part, its numbers: overall size, volume, surface area, counts of holes and triangles,
    the units of a DXF;
  - **the manufacturability notes for every part** (the DFM checks), which are sentences about the
    part and can include a measured value and where on the part it is ("hole Ø3.2 mm at x 41, y 12");
  - the priced lines of every quote and order, which carry a summary of the part in numbers (stock
    size, material removed, counts of holes and pockets, thinnest wall);
  - without a key set (today): also the outline of every small DXF and the preview mesh of every
    small model, as before.
  Treat a database backup as confidential: it is a customer list and an order book, and its
  manufacturability notes say something about each part.
- **A file while it is being read.** An upload is on the volume as it arrived for as long as the
  parser needs it: normally a second or two, at most 90 seconds. It is encrypted the moment it has
  been read. If the service is killed in that window the file stays as it arrived; the next start
  removes it once it is 15 minutes old.
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

- `File encryption: on — new CAD uploads, quote drawings, RFQ attachments and part preview meshes are stored encrypted (AES-256-GCM).`
  → it worked. If the site already held parts, the line `Part payloads: file encryption is on — moved
  the shape data of N part(s) out of the database rows into encrypted files` follows once.
- `ERROR: EXISTING FILES CANNOT BE OPENED — …` in a box of `═` lines
  → the key you entered is not the one the files on the volume were written with (see "Changing the
  key later"). The site is up and takes new uploads, but parts uploaded earlier cannot be priced,
  reopened or downloaded until the earlier key is listed. Nothing has been deleted.
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

Do not simply replace the value: files stored under the old key would stop opening — and since
2026-11-11 that includes what was measured from each part, so **parts uploaded under the old key
could not be priced or reopened** (buyers would be asked to upload them again, and checkout of a
quote made from them would be refused) until the old key is listed as below. The deploy log says so
in capitals if it happens (`EXISTING FILES CANNOT BE OPENED`), and listing the old key fixes it at
once; nothing is lost.

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
| A buyer re-pricing a part is told "we can no longer read what we measured from this file" | Same cause: with a key set, what was measured from every part is in an encrypted file | Same fix (it takes effect at the next deploy, for every part at once); a buyer who cannot wait can re-upload |
| The deploy log shows `EXISTING FILES CANNOT BE OPENED` | The key was changed and the old one is not listed | Put the earlier key in `NORD_FILE_ENC_KEY_PREVIOUS` and deploy |
| The key is lost for good | Files stored under it cannot be recovered | Quotes, prices and orders are unaffected (they use the database). Ask the customer for the file again when a job needs it |
| The site will not deploy after you set the key | The key is too short or a placeholder | See Step 4; the previous deployment is still serving |

Turning encryption **off** again (removing the variable) does not decrypt anything: files already
encrypted stay unreadable until the key is put back.

## How it works, for whoever maintains the code

`server/services/fileCrypto.js`. Key = SHA-256 of the variable's text. Each file gets a fresh
96-bit nonce; the file on disk is `"SEF1" | key id (4 bytes) | nonce (12) | tag (16) | ciphertext`.
The key id is the first four bytes of an HMAC of a fixed label under the key: it tells which key
wrote a file without revealing the key. A file that fails authentication (altered, truncated, wrong
key) is refused before any plaintext is returned; `openDecryptStream()` keeps that promise for
streamed previews by reading the file twice (once to authenticate, once to send). With a key set,
`models/partPayloads.js split()` sends every mesh and every part's geometry detail to a file whatever
its size, and `models/partPayloadMigration.js` moves rows stored earlier at start-up. Tests:
`server/services/fileCryptoKeys.test.js`, `server/security/fileEncryption.test.js` and
`server/routes/quoteSessionMesh.test.js` (keys are random, generated when the test runs).
