#!/usr/bin/env node
/**
 * Create the Nord MFG launch promo codes in Stripe.
 *
 * The checkout flow already passes `allow_promotion_codes: true`, so once these
 * exist in your Stripe account, customers can enter them at checkout.
 *
 * Usage:
 *   # Dry run (default — prints what WOULD be created, makes no changes):
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/create-stripe-promo-codes.js
 *
 *   # Actually create them:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/create-stripe-promo-codes.js --live
 *
 * Idempotent: it looks for an existing promotion code with the same code string
 * and skips creation if one already exists.
 */

const PROMOS = [
  { code: "LAUNCH25", percent_off: 25 },
  { code: "REDDIT15", percent_off: 15 },
  { code: "HACKERNEWS", percent_off: 15 },
  { code: "LOCAL10", percent_off: 10 },
  { code: "REFER30", percent_off: 30 },
];

async function main() {
  const live = process.argv.includes("--live");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("ERROR: set STRIPE_SECRET_KEY in the environment first.");
    process.exit(1);
  }
  const stripe = require("stripe")(key);
  const mode = key.startsWith("sk_live_") ? "LIVE" : "TEST";
  console.log(`Stripe key mode: ${mode}${live ? "" : "  (dry run — pass --live to apply)"}\n`);

  for (const promo of PROMOS) {
    // Already exists?
    const existing = await stripe.promotionCodes.list({ code: promo.code, limit: 1 });
    if (existing.data.length > 0) {
      console.log(`= ${promo.code.padEnd(12)} already exists — skipping`);
      continue;
    }
    if (!live) {
      console.log(`+ ${promo.code.padEnd(12)} would create: ${promo.percent_off}% off, once`);
      continue;
    }
    // Create a one-time coupon, then a promotion code customers can type.
    const coupon = await stripe.coupons.create({
      percent_off: promo.percent_off,
      duration: "once",
      name: `${promo.code} (${promo.percent_off}% off)`,
    });
    await stripe.promotionCodes.create({ coupon: coupon.id, code: promo.code });
    console.log(`+ ${promo.code.padEnd(12)} created: ${promo.percent_off}% off, once`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
