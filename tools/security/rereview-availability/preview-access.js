#!/usr/bin/env node
/**
 * Item 7 of the re-review: who can read a part's preview and geometry, and is the verified-human
 * token really bound to the client that earned it? (Checks; every line is expected to say "refused".)
 * A passing result: `leaks` is empty.
 *
 *   node tools/security/rereview-availability/preview-access.js off   bot check off
 *   node tools/security/rereview-availability/preview-access.js on    bot check on (repository stand-in)
 */
const crypto = require("crypto");
const c = require("./common");
const on = process.argv[2] === "on";

(async () => {
  const s = await c.startServer({ stubs: true, turnstile: on });
  try {
    const A = "198.51.100.31"; const B = "203.0.113.31";
    const tokA = on ? await c.humanToken(s, A) : "";
    const tokB = on ? await c.humanToken(s, B) : "";
    const hA = on ? { "X-Human-Token": tokA } : {};
    const hB = on ? { "X-Human-Token": tokB } : {};
    const T = on ? { "X-Turnstile-Token": "pass-x" } : {};
    const rows = []; const leaks = [];
    const check = (what, status, expectRefused = true) => { const refused = status >= 400; rows.push({ what, status, verdict: refused ? "refused" : "ALLOWED" }); if (expectRefused && !refused) leaks.push(what); };

    // Visitor A (no account) uploads a dense part (its mesh lives in a file) and prices it.
    const dense = require("../../../server/testSupport/zip").solidStl(24);
    const partA = await c.uploadOne(s, "a.stl", dense, { ip: A, headers: hA });
    const { line } = await c.lineFor(s, partA.partId, "cnc", A);
    const qA = await s.post("/api/quote", { parts: [{ ...line, subProcess: "milling" }], leadTimeSlug: "standard" }, { ip: A, headers: hA });
    // A signed-in customer C uploads and prices theirs.
    const C = "198.51.100.32";
    const tokC = await s.register("owner-of-c@example.test", { ip: C, headers: T });
    const partC = await c.uploadOne(s, "c.stl", dense, { ip: C, token: tokC });
    const qC = await s.post("/api/quote", { parts: [{ ...line, partId: partC.partId, subProcess: "milling" }], leadTimeSlug: "standard" }, { ip: C, token: tokC });
    const tokD = await s.register("someone-else@example.test", { ip: B, headers: T });

    const mesh = (id, o) => s.get(`/api/parts/${id}/mesh`, o).then((r) => r.status);
    const geom = (id, o) => s.get(`/api/parts/${id}/geometry`, o).then((r) => r.status);
    // The owner's own access works (control).
    check("control: A reads A's preview with A's key", await mesh(partA.partId, { ip: A, headers: { ...hA, "X-Part-Key": partA.editKey } }), false);
    // Guessing.
    check("B reads A's preview with the part id alone", await mesh(partA.partId, { ip: B, headers: hB }));
    check("B reads A's geometry with the part id alone", await geom(partA.partId, { ip: B, headers: hB }));
    check("B reads A's preview with the key of ANOTHER part", await mesh(partA.partId, { ip: B, headers: { ...hB, "X-Part-Key": partC.editKey } }));
    check("B reads A's preview with a random 40-character key", await mesh(partA.partId, { ip: B, headers: { ...hB, "X-Part-Key": crypto.randomBytes(20).toString("hex") } }));
    check("B reads a random part id", await mesh(crypto.randomUUID(), { ip: B, headers: hB }));
    check("a signed-in customer D reads guest A's preview (no key)", await mesh(partA.partId, { ip: B, token: tokD }));
    check("guest B reads customer C's preview (no key)", await mesh(partC.partId, { ip: B, headers: hB }));
    check("customer D reads customer C's preview (no key)", await mesh(partC.partId, { ip: B, token: tokD }));
    check("guest B opens customer C's quote session", (await s.get(`/api/quote/${qC.body.quoteId}/session`, { ip: B, headers: hB })).status);
    check("customer D opens customer C's quote session", (await s.get(`/api/quote/${qC.body.quoteId}/session`, { ip: B, token: tokD })).status);
    check("customer D re-prices customer C's quote", await s.post("/api/quote", { parts: [{ ...line, partId: partC.partId, subProcess: "milling" }], leadTimeSlug: "standard", quoteId: qC.body.quoteId }, { ip: B, token: tokD }).then((r) => (r.status === 200 && r.body.quoteId !== qC.body.quoteId ? 409 : r.status)));
    check("B opens a random quote id", (await s.get(`/api/quote/${crypto.randomUUID()}/session`, { ip: B, headers: hB })).status);
    // By design, stated so the owner knows: a quote made without an account is opened by its id alone, and the answer carries the part keys.
    const guestSession = await s.get(`/api/quote/${qA.body.quoteId}/session`, { ip: B, headers: hB });
    rows.push({ what: "BY DESIGN: anyone who has guest A's quote id opens the quote and receives its part keys", status: guestSession.status, verdict: guestSession.status === 200 ? "allowed (the id is the secret)" : "refused" });
    // Ids: are they random?
    const ids = [partA.partId, partC.partId, qA.body.quoteId, qC.body.quoteId];
    const v4 = ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
    // A quote id the client chooses never becomes a row.
    const chosen = crypto.randomUUID();
    const forced = await s.post("/api/quote", { parts: [{ ...line, subProcess: "milling" }], leadTimeSlug: "standard", quoteId: chosen }, { ip: A, headers: hA });
    check("a quote id chosen by the client becomes the new quote's id", forced.status === 200 && forced.body.quoteId === chosen ? 200 : 409);

    if (on) {
      // The verified-human token is for the client that passed the check.
      check("token earned at address A, upload from address B", (await s.upload([{ name: "x.stl", data: c.g.stlCube(10) }], { ip: B, headers: { "X-Human-Token": tokA } })).status);
      check("token earned at address A, pricing from address B", (await s.post("/api/quote", { parts: [{ ...line, subProcess: "milling" }], leadTimeSlug: "standard" }, { ip: B, headers: { "X-Human-Token": tokA } })).status);
      check("token earned at address A, quote session from address B", (await s.get(`/api/quote/${qA.body.quoteId}/session`, { ip: B, headers: { "X-Human-Token": tokA } })).status);
      check("token earned at address A, A's preview (with its key) from address B", await mesh(partA.partId, { ip: B, headers: { "X-Human-Token": tokA, "X-Part-Key": partA.editKey } }));
      check("no token at all: quote session", (await s.get(`/api/quote/${qA.body.quoteId}/session`, { ip: A })).status);
      check("no token at all: preview with the right key", await mesh(partA.partId, { ip: A, headers: { "X-Part-Key": partA.editKey } }));
      check("an account whose email is NOT confirmed, no token: upload", (await s.upload([{ name: "x.stl", data: c.g.stlCube(10) }], { ip: "198.51.100.40", token: await s.register("unconfirmed@example.test", { ip: "198.51.100.40", verify: false, headers: T }) })).status);
      // Same IPv6 /64 is one client by design.
      const v6 = await c.humanToken(s, "2001:db8:5:1::1");
      rows.push({ what: "BY DESIGN: token earned at 2001:db8:5:1::1 used from 2001:db8:5:1:ffff::9 (same /64)", status: (await s.upload([{ name: "x.stl", data: c.g.stlCube(10) }], { ip: "2001:db8:5:1:ffff::9", headers: { "X-Human-Token": v6 } })).status, verdict: "one client" });
      check("token earned in one /64 used from the next /64", (await s.upload([{ name: "x.stl", data: c.g.stlCube(10) }], { ip: "2001:db8:5:2::1", headers: { "X-Human-Token": v6 } })).status);
    }
    c.result({ test: "preview-access", botCheck: on ? "on (stand-in)" : "off", idsAreRandomVersion4Uuids: v4, leaks, rows });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
