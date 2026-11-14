/**
 * A request whose change could not be written to the database file does not answer "done"
 * (review of 2026-11-13, N-08).
 *
 * The database lives in memory and is written to its file after every change. When that write
 * fails (the disk is full, the volume is gone), the change is in memory and NOT on the disk. Until
 * this file existed the site carried on and answered "created": an account made while the disk was
 * full was acknowledged and then lost at the next restart.
 *
 * models/database.js counts every write of the file that fails. This middleware notes the count
 * when a request that can change something arrives (anything but GET, HEAD and OPTIONS) and looks
 * again when the route answers: if a write failed in between, the route's own answer is replaced
 * by one plain refusal, 503 `save-failed`, whatever the route was about to say. So:
 *
 *   - nothing is acknowledged to a customer that is not on the disk;
 *   - every route is covered, including the ones that log an error and carry on;
 *   - the customer reads one sentence and never a stack trace or a developer's "Failed to …".
 *
 * The check is "a save failed while this request was being handled", not "this request's own
 * save failed": two requests that overlap at the moment the disk fills can both be refused when
 * only one of them wrote. That errs on the safe side (a refused request can be sent again).
 *
 * Not covered here, and said so in the runbook: a re-priced draft quote, which is allowed to reach
 * the file up to 1.5 s after its answer (models/database.js deferred()). The health check turns
 * "unavailable" when such a write fails, like any other.
 */
const database = require("../models/database");

const MESSAGE = "We could not save that just now, so it has not gone through. That is a fault on our side. Please try again in a few minutes.";

function saveGuard(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const before = database.saveFailures();
  const send = res.send;
  res.send = function guardedSend(body) {
    res.send = send;
    if (database.saveFailures() !== before && !res.headersSent) {
      res.status(503);
      res.set("Retry-After", "120");
      res.set("Cache-Control", "no-store");
      res.type("json");
      return send.call(this, JSON.stringify({ error: MESSAGE, code: "save-failed" }));
    }
    return send.call(this, body);
  };
  next();
}

module.exports = { saveGuard, MESSAGE };
