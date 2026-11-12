#!/usr/bin/env node
/**
 * RR-06: uploadGuards.lingerThenClose — how long, how many, and what rides on the lingering connection.
 * A passing fix: every `closedAfterMs` is at or under the documented 5 s (6 s when the body ended),
 * `pipelined.executed` is false, and a refused upload's discarded bytes are charged to the sender's budget.
 *
 *   node tools/security/rereview-availability/linger.js hold        one refused upload, four ways of stalling: when does the server close?
 *   node tools/security/rereview-availability/linger.js many [n=400] n refused uploads held open at once: memory, health, open sockets
 *   node tools/security/rereview-availability/linger.js pipeline    a second request sent on the same connection after the refused one
 *   node tools/security/rereview-availability/linger.js free        bytes a refused upload may send without being charged to its daily budget
 *
 * Raw sockets against the real server on a throwaway folder. Limits are the defaults.
 */
const net = require("net");
const c = require("./common");

const mode = process.argv[2] || "hold";

/** Open a socket, send `head`, then let `feed(socket)` decide what to send. Resolves when the server closes it (or at maxMs). */
function rawRequest(port, head, { feed, maxMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect(port, "127.0.0.1");
    let got = ""; let finAt = null; let closedAt = null; let sent = 0; let done = false;
    const finish = (how) => { if (done) return; done = true; clearTimeout(cap); try { sock.destroy(); } catch { /* gone */ } resolve({ how, statusLine: got.split("\r\n")[0] || "", answer: got, serverFinAfterMs: finAt, closedAfterMs: closedAt !== null ? closedAt : Date.now() - t0, bytesSent: sent, stillOpenAtCap: how === "cap" }); };
    const cap = setTimeout(() => finish("cap"), maxMs);
    sock.setNoDelay(true);
    sock.on("connect", () => { sock.write(head); sent += Buffer.byteLength(head); if (feed) feed({ sock, write: (b) => { if (done || sock.destroyed) return false; sent += b.length; return sock.write(b); }, since: () => Date.now() - t0, isDone: () => done }); });
    sock.on("data", (d) => { got += d.toString("latin1"); });
    sock.on("end", () => { if (finAt === null) finAt = Date.now() - t0; }); // the server finished ITS half; we may still send
    sock.on("close", () => { closedAt = Date.now() - t0; finish("closed"); });
    sock.on("error", () => { closedAt = Date.now() - t0; finish("reset"); });
    sock.allowHalfOpen = true;
  });
}

const uploadHead = (ip, length, extra = "") => `POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: multipart/form-data; boundary=xx\r\nContent-Length: ${length}\r\n${extra}\r\n`;
const TOO_BIG = 600 * c.MB; // over the route's maximum (10 files of 50 MB + 1 MB): refused at the door, code request-too-large

async function hold() {
  const s = await c.startServer();
  try {
    const rows = [];
    const drip = (everyMs, bytes) => ({ write, isDone }) => { const t = setInterval(() => { if (isDone()) return clearInterval(t); write(Buffer.alloc(bytes, 0x41)); }, everyMs); };
    const cases = [
      ["sends the headers, then nothing", undefined],
      ["drips 1 byte every 500 ms", drip(500, 1)],
      ["drips 1 byte every 50 ms", drip(50, 1)],
      ["sends 1 MB every 100 ms", drip(100, c.MB)],
    ];
    let n = 0;
    // A client that has stopped sending never learns that the server closed (nothing more is sent to it), so the
    // server's own side is what is measured: its count of open sockets (/proc/<pid>/fd) back to where it was.
    const fds = () => { try { return require("fs").readdirSync(`/proc/${s.pid}/fd`).length; } catch { return -1; } };
    for (const [label, feed] of cases) {
      await c.sleep(1500);
      const base = fds();
      const t0 = Date.now();
      let serverSideClosedAfterMs = null; let sawOpen = false;
      const watch = setInterval(() => { const now = fds(); if (now > base) sawOpen = true; else if (sawOpen && serverSideClosedAfterMs === null) serverSideClosedAfterMs = Date.now() - t0; }, 50);
      const r = await rawRequest(s.port, uploadHead(`192.0.2.${10 + n++}`, TOO_BIG), { feed, maxMs: 15000 });
      clearInterval(watch);
      rows.push({ client: label, answer: r.statusLine, serverFinishedItsHalfAfterMs: r.serverFinAfterMs, serverSideSocketClosedAfterMs: serverSideClosedAfterMs, clientSawTheCloseAfterMs: r.stillOpenAtCap ? null : r.closedAfterMs, bytesSentByClient: r.bytesSent });
      c.log(JSON.stringify(rows[rows.length - 1]));
    }
    c.result({ test: "linger hold", documented: "at most 5 s and 64 MB, then closed", rows });
  } finally { await s.stop(); }
}

async function many() {
  const n = Number(process.argv[3]) || 400;
  const s = await c.startServer();
  try {
    const fds = () => { try { return require("fs").readdirSync(`/proc/${s.pid}/fd`).length; } catch { return -1; } };
    const base = { rssMb: c.rssMb(s.pid), fds: fds() };
    const mon = c.monitor(s);
    const t0 = Date.now();
    let peakFds = base.fds; let peakRss = base.rssMb;
    const watch = setInterval(() => { peakFds = Math.max(peakFds, fds()); peakRss = Math.max(peakRss, c.rssMb(s.pid)); }, 100);
    // Each from its own address (the upload limiter allows one address 50 refused uploads per 15 minutes), each dripping a byte a second.
    const all = await Promise.all(Array.from({ length: n }, (_, i) => rawRequest(s.port, uploadHead(`198.18.${Math.floor(i / 250)}.${1 + (i % 250)}`, TOO_BIG), { maxMs: 40000, feed: ({ write, isDone }) => { const t = setInterval(() => { if (isDone()) return clearInterval(t); write(Buffer.from("A")); }, 1000); } })));
    clearInterval(watch);
    const m = await mon.stop();
    const closed = all.map((r) => r.closedAfterMs).sort((a, b) => a - b);
    const answered = all.filter((r) => /413/.test(r.statusLine)).length;
    c.result({
      test: "linger many", connections: n, answered413: answered, refusedOtherwise: n - answered,
      closedAfterMs: { min: closed[0], median: closed[Math.floor(closed.length / 2)], max: closed[closed.length - 1] }, stillOpenAfter40s: all.filter((r) => r.stillOpenAtCap).length,
      server: { rssMbBefore: base.rssMb, rssMbPeak: peakRss, openFilesBefore: base.fds, openFilesPeak: peakFds },
      health: { medianMs: m.medianMs, worstMs: m.worstMs, failures: m.failures }, wallSeconds: Math.round((Date.now() - t0) / 1000),
    });
  } finally { await s.stop(); }
}

async function pipeline() {
  const s = await c.startServer();
  try {
    const ip = "192.0.2.40";
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    const admin = await s.admin({ ip: "198.51.100.1" });
    const count = async () => Number((await s.get("/api/admin/quotes", { ip: "198.51.100.1", headers: await s.browser(admin) })).headers["x-total-count"]);
    const before = await count();
    // A refused request whose whole body arrives (the request form: 26 MB at most, so 26 MB + 1 is refused at the door and lingers) ...
    const length = 26 * c.MB + 1;
    const head = `POST /api/rfq HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: multipart/form-data; boundary=xx\r\nContent-Length: ${length}\r\n\r\n`;
    // ... followed on the same connection by a pricing request that creates a draft quote.
    const json = JSON.stringify({ parts: [line], leadTimeSlug: "standard" });
    const second = `POST /api/quote HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
    // 2026-11-12, added with the fix: the client here keeps its half open after the server's answer and so
    // never learns of the server's close (see hold()), so the server's own side is measured as well, the
    // way hold() does it: its count of open sockets back to where it was.
    const fds = () => { try { return require("fs").readdirSync(`/proc/${s.pid}/fd`).length; } catch { return -1; } };
    const baseFds = fds(); const tFd = Date.now(); let serverSideClosedAfterMs = null; let sawOpen = false;
    const watch = setInterval(() => { const now = fds(); if (now > baseFds) sawOpen = true; else if (sawOpen && serverSideClosedAfterMs === null) serverSideClosedAfterMs = Date.now() - tFd; }, 50);
    const r = await rawRequest(s.port, head, { maxMs: 20000, feed: async ({ write, isDone }) => {
      const chunk = Buffer.alloc(c.MB, 0x20);
      for (let left = length; left > 0 && !isDone();) { const b = left >= chunk.length ? chunk : chunk.subarray(0, left); write(b); left -= b.length; await c.sleep(5); }
      if (!isDone()) write(Buffer.from(second));
    } });
    await c.sleep(2500);
    clearInterval(watch);
    const after = await count();
    const answers = (r.answer.match(/HTTP\/1\.1 \d+/g) || []);
    c.result({
      test: "linger pipeline", firstAnswer: r.statusLine, answersOnTheConnection: answers, connectionClosedAfterMs: r.closedAfterMs, serverSideSocketClosedAfterMs: serverSideClosedAfterMs,
      pipelined: { request: "POST /api/quote (a new draft)", answered: answers.length > 1, executed: after > before, draftQuotesBefore: before, draftQuotesAfter: after },
    });
  } finally { await s.stop(); }
}

async function free() {
  const s = await c.startServer({ env: { UPLOAD_DAILY_MB_PER_IP: "20" } }); // a small budget so the sum is easy to read
  try {
    const ip = "192.0.2.60";
    let sentTotal = 0; const rows = [];
    for (let i = 0; i < 4; i++) {
      const r = await rawRequest(s.port, uploadHead(ip, TOO_BIG), { maxMs: 20000, feed: async ({ write, isDone }) => { const chunk = Buffer.alloc(c.MB, 0x41); while (!isDone()) { write(chunk); await c.sleep(2); } } });
      sentTotal += r.bytesSent;
      rows.push({ answer: r.statusLine, mbSentBeforeTheClose: Math.round(r.bytesSent / c.MB), closedAfterMs: r.closedAfterMs });
    }
    // Is the budget (20 MB here) touched? A real upload afterwards tells.
    const up = await s.upload([{ name: "cube.stl", data: c.g.stlCube(20) }], { ip });
    c.result({ test: "linger free", dailyBudgetMb: 20, refusedUploads: rows, mbSentInAll: Math.round(sentTotal / c.MB), uploadAfterwards: { status: up.status, code: (up.body && up.body.code) || "", parts: up.body && up.body.parts ? up.body.parts.length : 0 }, note: "what the socket accepted from this script; the server reads and throws away at most 64 MB of it per connection" });
  } finally { await s.stop(); }
}

({ hold, many, pipeline, free }[mode] || hold)().catch((e) => { console.error(e); process.exit(1); });
