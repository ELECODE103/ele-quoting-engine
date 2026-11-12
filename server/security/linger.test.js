/**
 * A refused upload on the real server: what the connection may still do while it is being closed.
 * (independent re-review 2026-11-12, RR-06.)
 *
 *  - what a refused sender keeps sending is read and thrown away, and counts against that sender's day;
 *  - a second request sent on the same connection is not run;
 *  - once the refused body has all arrived, the server's side of the connection goes within about a second.
 *
 * Raw sockets, because a browser never does any of this. Run: node server/security/linger.test.js
 */
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Refused uploads: the connection afterwards (live server)");
const MB = 1024 * 1024;
const cube = fs.readFileSync(path.join(live.ROOT, "tools", "vet-quotes", "parts", "cube_20mm.stl"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send `head`, let `feed` write what it likes, resolve with what came back when the server closes or at maxMs. */
function raw(port, head, feed, maxMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let got = ""; let sent = 0; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(cap); try { sock.destroy(); } catch { /* gone */ } resolve({ answers: got.match(/HTTP\/1\.1 \d+/g) || [], text: got, sent }); };
    const cap = setTimeout(finish, maxMs);
    sock.on("connect", () => { sock.write(head); feed({ write: (b) => { if (done || sock.destroyed) return; sent += b.length; sock.write(b); }, isDone: () => done }); });
    sock.on("data", (d) => { got += d.toString("latin1"); });
    sock.on("close", finish);
    sock.on("error", finish);
  });
}
const openFiles = (pid) => fs.readdirSync(`/proc/${pid}/fd`).length;

let s;

test("what a refused sender keeps sending counts against their day, like any other byte", async () => {
  s = await live.start({ env: { UPLOAD_DAILY_MB_PER_IP: "6" } });
  const ip = "192.0.2.61";
  // Declared far over the route's maximum: refused at the door (413), nothing kept. The sender sends 8 MB anyway.
  const head = `POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: multipart/form-data; boundary=xx\r\nContent-Length: ${600 * MB}\r\n\r\n`;
  const r = await raw(s.port, head, async ({ write, isDone }) => { const chunk = Buffer.alloc(MB, 0x41); for (let i = 0; i < 8 && !isDone(); i++) { write(chunk); await sleep(5); } }, 8000);
  assert.deepStrictEqual(r.answers, ["HTTP/1.1 413"], r.text.slice(0, 200));
  assert.ok(r.sent >= 7 * MB, `the server took what was sent (${r.sent} bytes)`);
  // The day's allowance here is 6 MB and 8 MB were thrown away: an honest upload from the same address is now over it.
  const after = await s.upload([{ name: "cube.stl", data: cube }], { ip });
  assert.deepStrictEqual([after.status, after.body.code], [429, "daily-upload-limit"], after.text);
  // A customer who runs into the allowance still gets the reading-on (so the browser shows the answer). A sender
  // far past it (four full helpings of 64 MB here) is closed after about a megabyte.
  const flood = async ({ write, isDone }) => { const chunk = Buffer.alloc(MB, 0x41); for (let i = 0; i < 80 && !isDone(); i++) { write(chunk); await sleep(2); } };
  for (let i = 0; i < 4; i++) assert.deepStrictEqual((await raw(s.port, head, flood, 8000)).answers, ["HTTP/1.1 413"]);
  const again = await raw(s.port, head, flood, 8000);
  assert.deepStrictEqual(again.answers, ["HTTP/1.1 413"], "still answered");
  assert.ok(again.sent < 24 * MB, `closed early on a sender far over its allowance (${Math.round(again.sent / MB)} MB left the client before it noticed)`);
  // Somebody else is not affected.
  const other = await s.upload([{ name: "cube.stl", data: cube }], { ip: "192.0.2.62" });
  assert.strictEqual(other.body.parts.length, 1, other.text);
  state.part = other.body.parts[0];
});

const state = {};

test("a second request on the connection of a refused one is not run, and the server lets go of the connection", async () => {
  const ip = "192.0.2.62";
  const mats = (await s.get("/api/materials?process=cnc", { ip })).body;
  const line = { partId: state.part.partId, materialSlug: mats[0].slug, quantity: 2, process: "cnc", subProcess: "milling" };
  const admin = await s.admin({ ip: "198.51.100.1" });
  const drafts = async () => Number((await s.get("/api/admin/quotes", { ip: "198.51.100.1", token: admin })).headers["x-total-count"]);
  const before = await drafts();
  // Refused at the door with its whole (small) body sent, then a pricing request on the same connection.
  const length = 26 * MB + 1; // one byte over what the request form takes
  const head = `POST /api/rfq HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: multipart/form-data; boundary=xx\r\nContent-Length: ${length}\r\n\r\n`;
  const json = JSON.stringify({ parts: [line], leadTimeSlug: "standard" });
  const second = `POST /api/quote HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
  await sleep(6000); // connections of the requests above have gone: the count below is the server at rest
  const atRest = openFiles(s.child.pid);
  let sawOpen = false; let serverLetGoAfterMs = null; const t0 = Date.now();
  const watch = setInterval(() => { const now = openFiles(s.child.pid); if (now > atRest) sawOpen = true; else if (sawOpen && serverLetGoAfterMs === null) serverLetGoAfterMs = Date.now() - t0; }, 25);
  const r = await raw(s.port, head, async ({ write, isDone }) => {
    const chunk = Buffer.alloc(MB, 0x20);
    for (let left = length; left > 0 && !isDone();) { const b = left >= chunk.length ? chunk : chunk.subarray(0, left); write(b); left -= b.length; await sleep(3); }
    write(Buffer.from(second));
  }, 4000);
  await sleep(500);
  clearInterval(watch);
  assert.deepStrictEqual(r.answers, ["HTTP/1.1 413"], "one answer on the connection: the refusal");
  assert.strictEqual(await drafts(), before, "the second request made no quote");
  assert.ok(serverLetGoAfterMs !== null && serverLetGoAfterMs < 3000, `the server closed its side (after ${serverLetGoAfterMs} ms)`);
  // The same request on a connection of its own is an ordinary one.
  const own = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip });
  assert.strictEqual(own.status, 200, own.text);
});

test("a refused body that arrives whole and then says nothing: the server's side is gone in about a second", async () => {
  const ip = "192.0.2.63";
  const length = 26 * MB + 1;
  const head = `POST /api/rfq HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: multipart/form-data; boundary=xx\r\nContent-Length: ${length}\r\n\r\n`;
  await sleep(6000);
  const atRest = openFiles(s.child.pid);
  let sawOpen = false; let goneAfterBodyMs = null; let bodyDoneAt = null;
  const watch = setInterval(() => { const now = openFiles(s.child.pid); if (now > atRest) sawOpen = true; else if (sawOpen && goneAfterBodyMs === null && bodyDoneAt !== null) goneAfterBodyMs = Date.now() - bodyDoneAt; }, 25);
  // The client sends everything, keeps its own half open and never reads on: the server must not wait for it.
  await raw(s.port, head, async ({ write, isDone }) => {
    const chunk = Buffer.alloc(MB, 0x20);
    for (let left = length; left > 0 && !isDone();) { const b = left >= chunk.length ? chunk : chunk.subarray(0, left); write(b); left -= b.length; await sleep(3); }
    bodyDoneAt = Date.now();
  }, 4000);
  clearInterval(watch);
  assert.ok(goneAfterBodyMs !== null && goneAfterBodyMs < 2500, `the server's side closed ${goneAfterBodyMs} ms after the body ended`);
  await s.stop();
});

run();
