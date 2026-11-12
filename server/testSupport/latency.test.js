/**
 * The latency helper itself: robust on a busy machine, and still able to fail.
 * Run: node server/testSupport/latency.test.js
 */
const assert = require("assert");
const { runner } = require("./harness");
const { machineProbe, assertResponsive } = require("./latency");

const { test, run } = runner("Latency assertions (test support)");
const quiet = Array.from({ length: 60 }, (_, i) => 3 + (i % 7));

test("a quiet machine is held to the test's own bound, as before", () => {
  assert.ok(/worst 9 ms/.test(assertResponsive(quiet, { tightMs: 250, tookMs: 10000, machineMs: 4, idle: [2, 3, 5], what: "health check" })));
  assert.throws(() => assertResponsive([...quiet, 260], { tightMs: 250, tookMs: 10000, machineMs: 4, idle: [2, 3], what: "health check" }), /over 250 ms plus the 4 ms stall/);
});

test("a stall the machine itself showed in the same window is allowed for; nothing beyond it", () => {
  assertResponsive([...quiet, 337], { tightMs: 250, tookMs: 10000, machineMs: 190, idle: [2, 3], what: "health check" });
  assertResponsive([...quiet, 337], { tightMs: 250, tookMs: 10000, machineMs: 0, idle: [2, 230], what: "health check" });
  assert.throws(() => assertResponsive([...quiet, 600], { tightMs: 250, tookMs: 10000, machineMs: 190, idle: [2, 3], what: "health check" }), /over 250 ms plus the 190 ms stall/);
});

test("work on the event loop fails on any machine: the ceiling is not relaxed by a busy one", () => {
  // A 2.2 s parse on the main thread holds one answer for about that long.
  assert.throws(() => assertResponsive([...quiet, 2150], { tightMs: 250, tookMs: 2200, machineMs: 5000, idle: [4000], what: "health check" }), /holding the event loop/);
  // Half the time the work took, when that is under a second.
  assert.throws(() => assertResponsive([700], { tightMs: 250, tookMs: 1200, machineMs: 5000, what: "timer" }), /holding the event loop \(ceiling 600 ms/);
  assert.throws(() => assertResponsive([1000], { tightMs: 250, machineMs: 5000, what: "timer" }), /ceiling 1000 ms/);
});

test("free most of the time is not enough: nine in ten samples must be quick", () => {
  const sluggish = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 180 : 4));
  assert.throws(() => assertResponsive(sluggish, { tightMs: 250, tookMs: 10000, machineMs: 0, what: "health check" }), /nine in ten/);
  assert.throws(() => assertResponsive([], { tightMs: 250, what: "health check" }), /nothing was measured/);
});

test("the probe reports a small number when nothing is wrong, and sees this thread when asked to", async () => {
  const idle = machineProbe();
  await new Promise((r) => setTimeout(r, 150));
  const ms = await idle.stop();
  assert.ok(Number.isInteger(ms) && ms >= 0 && ms < 1000, `idle probe: ${ms} ms`);
  const watching = machineProbe({ mainThread: true });
  await new Promise((r) => setTimeout(r, 60));
  const until = Date.now() + 120; while (Date.now() < until) { /* hold this thread */ }
  await new Promise((r) => setTimeout(r, 60));
  assert.ok((await watching.stop()) >= 80, "a held main thread is seen by the main-thread watch");
});

run();
