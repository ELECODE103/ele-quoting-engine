const c = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/tools/security/review/lib/common.js");
const crypto = require("crypto");
(async () => {
  // ---- unknown-process underpayment, full checkout to "paid"
  let s = await c.start({ mailer: true });
  try {
    const ip = "203.0.113.5";
    const A = await s.register("a@example.test", { ip });
    const up = await s.upload([{ name: "big.stl", data: c.boxStl([120, 90, 60]) }], { ip, token: A });
    const partId = up.body.parts[0].partId;
    const honest = (await s.post("/api/quote", { parts: [{ partId, materialSlug: "cnc-peek", process: "cnc", quantity: 5 }] }, { ip, token: A })).body;
    const cheat = (await s.post("/api/quote", { parts: [{ partId, materialSlug: "cnc-peek", process: "totally-made-up", quantity: 5 }] }, { ip, token: A })).body;
    console.log("honest cnc total", honest.orderTotal, "rfq", honest.gate.requiresRfq, honest.gate.reasons.map(r=>r.code));
    console.log("unknown-process total", cheat.orderTotal, "rfq", cheat.gate.requiresRfq);
    const co = await s.post("/api/orders/checkout-session", { quoteId: cheat.quoteId, shippingName: "A", shippingAddress: "1 A St", shippingCity: "C", shippingState: "IL", shippingZip: "60000" }, { ip, token: A });
    const sess = Object.values(s.state().sessions).pop();
    s.payAll();
    await s.post(`/api/orders/${co.body.orderId}/confirm-payment`, {}, { ip, token: A });
    const admin = await s.admin({ ip: "203.0.113.1" });
    const ord = await s.get(`/api/orders/${co.body.orderId}`, { token: admin, ip: "203.0.113.1" });
    console.log("Stripe charged cents", sess.amount_total, "order status", ord.body.status, "total", ord.body.total, "items", ord.body.items.map(i=>({process:i.process,material:i.materialName,qty:i.quantity,line:i.lineTotal})));
  } finally { await s.stop(); }

  // ---- no-mailer ADMIN_RECOVERY=verify-email promotes whoever holds ADMIN_EMAIL
  s = await c.start({ turnstile: false }); // no mailer, bot check off (launch-as-forgotten)
  try {
    const atkIp = "198.51.100.9";
    const pw = "Aa1-" + crypto.randomBytes(9).toString("base64url");
    const reg = await s.post("/api/auth/register", { email: s.adminEmail, password: pw, name: "x" }, { ip: atkIp, headers: { "X-Form-Token": s.formToken("register") } });
    console.log("no-mailer: attacker pre-registers ADMIN_EMAIL:", reg.status, "role", reg.body.user.role);
  } finally { await s.stop(); }
  // restart on the same data dir with ADMIN_RECOVERY set, the way the owner is told to recover
  s = await c.start({ turnstile: false });
  const dir = s.dataDir; const tmpDir = s.tmp; await s.stop({ keep: true });
  const s2 = await c.live.start({ tmpDir, env: { NODE_ENV: "production", USE_SQLITE: "true", QUOTING_DB_PATH: require("path").join(dir, "quoting.db"), QUOTING_DATA_DIR: dir, JWT_SECRET: crypto.randomBytes(32).toString("hex"), STRIPE_SECRET_KEY: "sk_test_x", ADMIN_EMAIL: "owner@shop.test", FRONTEND_URL: "http://127.0.0.1", ADMIN_RECOVERY: "verify-email" } });
  try {
    // we restarted with a fresh DB (tmpDir is the second server's own) — this path only proves the mechanism on a seeded owner.
    console.log("recovery startup log tail:", s2.log().split("\n").filter(l=>/ADMIN|Promoted|admin role/.test(l)).join(" | "));
  } finally { await s2.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
