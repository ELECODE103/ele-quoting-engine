# Independent pre-launch review — proofs of concept (2026-11-11)

These scripts belong to `docs/security/independent-review-2026-11-11.md`. They are an outside
reviewer's attacks against a **local** server only — never the live domains, Stripe, Cloudflare or
Resend. They changed no application code.

`lib/common.js` starts the real `server/index.js` in production mode through the project's own
`server/testSupport/liveServer.js`, with `lib/preload.js` (loaded via `NODE_OPTIONS=--require`)
keeping every outbound call on this host: Stripe is a local stub that records the sessions it is
asked to create, Resend "accepts" each message, and Turnstile passes a token that starts with
`pass`. Webhook signatures are still checked by the real Stripe library, offline.

Run one like:

```sh
env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 \
  node tools/security/review/poc-01-pricing-process-mismatch.js
```

| PoC | Shows |
|---|---|
| poc-01 | Any part priced far below the engine's number by naming a mismatched or unknown `process` (LB-1) |
| poc-02 | An honest $2085 CNC quote checked out and marked **paid** at $37; attacker pre-registers `ADMIN_EMAIL` |
| poc-03 | A DXF's units changed 25× after pricing but before checkout; buyer pays the stale small price (LB-2) |
| poc-04 | Full authorization matrix: guest / other buyer / unenrolled admin against every id-bearing route |
| poc-05 | Session cookie flags, cross-token replay, reset single-use + host, sign-in lockout of the owner |
| poc-06 | ADMIN_EMAIL promotion ride, Host-header link poisoning (safe), 2FA code reuse and brute-force accounting |
| poc-07 | CSRF: every cookie-session state change without `X-CSRF-Token` is refused (control: with it, 200) |
| poc-08 | Production security headers, 404, static exposure, download content-type on every response kind |
