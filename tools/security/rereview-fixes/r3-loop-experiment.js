#!/usr/bin/env node
/**
 * Second re-review (2026-11-13): what "doing the work in pieces" does and does not buy, on a BARE Node
 * HTTP server with no application code at all.
 *
 *   node tools/security/rereview-fixes/r3-loop-experiment.js
 *
 * The server does 12 pieces of 80 ms of work, each started from the last with setImmediate, which is how
 * the site's pricing runner and its checkout yield between pieces. While that runs, the script asks for
 * a trivial page every 5 ms two ways: on connections that are already open, and on new connections.
 * Prints the longest wait of each. On Node 20.20.0 here: an open connection waits one piece (88 ms); a
 * new connection waits for the whole chain (931 ms of 980).
 */
const http = require("http");
const { fork } = require("child_process");
if (process.argv[2] === "server") {
  const srv = http.createServer((req, res) => {
    if (req.url === "/work") { let n = 12; const piece = () => { const t = Date.now(); while (Date.now() - t < 80); if (--n > 0) setImmediate(piece); else res.end("done"); }; setImmediate(piece); return; }
    res.end("ok");
  });
  srv.listen(0, "127.0.0.1", () => process.send(srv.address().port));
} else {
  const child = fork(__filename, ["server"]);
  child.on("message", async (port) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
    const get = (path, a) => new Promise((resolve) => { const t = Date.now(); http.get({ host: "127.0.0.1", port, path, agent: a }, (res) => { res.resume(); res.on("end", () => resolve(Date.now() - t)); }).on("error", () => resolve(-1)); });
    await Promise.all(Array.from({ length: 24 }, () => get("/", agent)));
    const fresh = [], open = []; let stop = false;
    const t1 = setInterval(() => { if (!stop) get("/", false).then((ms) => fresh.push(ms)); }, 5);
    const t2 = setInterval(() => { if (!stop) get("/", agent).then((ms) => open.push(ms)); }, 5);
    await new Promise((r) => setTimeout(r, 300));
    const work = await get("/work", false);
    await new Promise((r) => setTimeout(r, 300));
    stop = true; clearInterval(t1); clearInterval(t2);
    await new Promise((r) => setTimeout(r, 500));
    console.log(JSON.stringify({ node: process.version, burstMs: work, pieces: "12 x 80 ms", worstOnNewConnectionMs: Math.max(...fresh), worstOnOpenConnectionMs: Math.max(...open), samples: [fresh.length, open.length] }));
    child.kill(); process.exit(0);
  });
}
