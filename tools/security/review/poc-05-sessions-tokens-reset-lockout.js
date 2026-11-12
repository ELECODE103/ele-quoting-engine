const c = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/tools/security/review/lib/common.js");
const jwt = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/node_modules/jsonwebtoken");
const totp = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/server/security/totp");
const crypto = require("crypto");
(async () => {
  const s = await c.start({ mailer: true });
  try {
    const ip = "203.0.113.5";
    // 1 cookie attributes
    const pw = "Aa1-" + crypto.randomBytes(9).toString("base64url");
    const reg = await s.post("/api/auth/register", { email: "a@example.test", password: pw, name: "<img src=x onerror=alert(1)>" }, { ip, headers: { "X-Form-Token": s.formToken("register") } });
    console.log("1 register", reg.status, reg.headers["set-cookie"], Object.keys(reg.body), reg.headers["cache-control"]);
    const tokA = reg.body.token;
    // 2 cross-replay
    const ft = (await s.get("/api/public/form-token?form=register", { ip })).body.formToken;
    const verifyMail = s.mail("a@example.test", /confirm/i).pop();
    const vtok = (verifyMail.text.match(/#token=(\S+)/) || [])[1];
    console.log("2 verify link", verifyMail.text.match(/https?:\/\/\S+/)[0].slice(0, 60));
    for (const [name, t] of [["form", ft], ["email-verify", vtok]]) {
      const r = await s.get("/api/auth/profile", { token: t, ip });
      const r2 = await s.post("/api/auth/password-reset/check", { token: t }, { ip });
      const r3 = await s.get(`/api/rfq/quote/${t}`, { ip });
      console.log(`2 ${name} as session:`, r.status, "as reset:", r2.body, "as firm-quote:", r3.status);
    }
    const sessAsVerify = await s.post("/api/auth/verify-email", { token: tokA }, { ip });
    const sessAsForm = await s.post("/api/auth/password-reset/request", { email: "a@example.test" }, { ip, headers: { "X-Form-Token": tokA } });
    console.log("2 session as verify:", sessAsVerify.status, "session as form token:", sessAsForm.status, sessAsForm.body.code);
    // 3 alg none / unsigned / wrong key
    const claims = jwt.decode(tokA);
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".";
    const empty = jwt.sign(claims, "x");
    console.log("3 alg none:", (await s.get("/api/auth/profile", { token: none, ip })).status, "wrong key:", (await s.get("/api/auth/profile", { token: empty, ip })).status);
    // 4 confirm then logout revocation
    await s.confirmEmail("a@example.test", { ip });
    console.log("4 verify reuse:", (await s.post("/api/auth/verify-email", { token: vtok }, { ip })).body);
    const before = await s.get("/api/auth/profile", { token: tokA, ip });
    await s.req({ method: "POST", url: "/api/auth/logout", token: tokA, ip });
    const after = await s.get("/api/auth/profile", { token: tokA, ip });
    console.log("4 before logout", before.status, "after", after.status);
    // 5 reset
    const login = async (email, password, extra = {}, fromIp = ip) => s.post("/api/auth/login", { email, password, ...extra }, { ip: fromIp });
    const l1 = await login("a@example.test", pw);
    const tokA2 = l1.body.token;
    const rr = await s.post("/api/auth/password-reset/request", { email: "a@example.test" }, { ip, headers: { "X-Form-Token": s.formToken("password-reset"), Host: "evil.example" } });
    await c.sleep(300);
    const rm = s.mail("a@example.test", /password/i).pop();
    console.log("5 reset req", rr.status, "link:", (rm.text.match(/https?:\/\/[^\s#]+/) || [])[0]);
    const rtok = (rm.text.match(/#token=(\S+)/) || [])[1];
    const rr2 = await s.post("/api/auth/password-reset/request", { email: "a@example.test" }, { ip: "203.0.113.77", headers: { "X-Form-Token": s.formToken("password-reset") } });
    await c.sleep(300);
    const rtok2 = (s.mail("a@example.test", /password/i).pop().text.match(/#token=(\S+)/) || [])[1];
    const pw2 = "Bb2-" + crypto.randomBytes(9).toString("base64url");
    console.log("5 reset as verify:", (await s.post("/api/auth/verify-email", { token: rtok }, { ip })).status);
    const conf = await s.post("/api/auth/password-reset/confirm", { token: rtok, password: pw2 }, { ip });
    const conf2 = await s.post("/api/auth/password-reset/confirm", { token: rtok, password: pw2 + "x" }, { ip });
    const conf3 = await s.post("/api/auth/password-reset/confirm", { token: rtok2, password: pw2 + "y" }, { ip });
    console.log("5 confirm", conf.status, "reuse", conf2.status, "sibling link", conf3.status, "old session after reset:", (await s.get("/api/auth/profile", { token: tokA2, ip })).status, "old pw:", (await login("a@example.test", pw)).status, "new pw:", (await login("a@example.test", pw2)).status);
    // 8 lockout DoS
    const adminTok = await s.admin({ ip: "203.0.113.1" });
    for (let i = 0; i < 5; i++) await login(s.adminEmail, "Wrong-pass-12345", {}, "203.0.113.200");
    const ownerTry = await login(s.adminEmail, s.passwords[s.adminEmail], { totp: totp.codeAt(s.adminSecret, Date.now() + 30000) }, "203.0.113.1");
    console.log("8 owner sign-in after 5 bad guesses from another IP:", ownerTry.status, ownerTry.body.code, ownerTry.body.retryAfterSeconds, "lock mails:", s.mail(s.adminEmail, /paused|sign-in|locked/i).length);
    console.log("8 existing admin session still works:", (await s.get("/api/admin/stats", { token: adminTok, ip: "203.0.113.1" })).status);
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
