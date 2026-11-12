#!/bin/sh
# Runs every proof of concept against servers it starts itself on free local ports.
# Nothing here reaches a live site or the Stripe API (see stripe-stub-preload.js).
cd "$(dirname "$0")/../../.." || exit 1
for f in tools/security/review-payments/poc-*.js; do
  env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 node "$f" || echo "!! $f exited with an error"
done
